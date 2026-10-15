//! Messages : parler à Lumen et à ses agents comme dans une messagerie.
//!
//! Pensé pour le grand public (à la manière de Muse chez Meta ou des « dots »
//! d'OpenAI) : une liste de discussions, un contact par discussion — Lumen
//! lui-même ou un agent de l'atelier, avec son avatar —, des bulles, les appels
//! d'outils montrés sobrement dans le fil, et la possibilité de « couper le
//! contexte » : un séparateur dans le fil au-delà duquel le modèle ne voit plus
//! ce qui précède.
//!
//! Le moteur vit ICI, côté ordinateur : l'app du bureau (commandes Tauri), le
//! compagnon web et l'app iOS (routes HTTP de companion.rs) ne font qu'afficher
//! et envoyer. Chaque changement part en direct : évènement `messenger` pour
//! les fenêtres du bureau, bus WebSocket pour les téléphones, notification
//! push quand la réponse arrive.
//!
//! Stockage : `profiles/<id>/messenger/threads.json` (+ `files/` pour les
//! images et documents échangés).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{Emitter, Manager};

const MAX_ROUNDS: usize = 6;
/// Messages rejoués au modèle (après la dernière coupure) : au-delà, le début
/// d'une longue discussion n'apporte plus grand-chose et coûte du contexte.
const HISTORY_MAX: usize = 30;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ToolCall {
    pub name: String,
    #[serde(default)]
    pub args: Value,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub running: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct FileRef {
    pub id: String,
    pub name: String,
    pub mime: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Msg {
    pub id: String,
    /// user | assistant | tool | cut | file | error
    pub role: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<FileRef>,
    /// Qui parle côté IA (« » = Lumen, sinon id d'agent).
    #[serde(default)]
    pub from: String,
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Thread {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// « » = Lumen, sinon l'id de l'agent interlocuteur.
    #[serde(default)]
    pub contact: String,
    pub created: u64,
    pub updated: u64,
    #[serde(default)]
    pub unread: u32,
    #[serde(default)]
    pub pinned: bool,
    /// Bouton « réponse orchestrée » du fil : FORCE l'orchestration. Éteint,
    /// c'est le moteur de décision qui choisit directe / outils / orchestrée.
    #[serde(default)]
    pub orchestrate: bool,
    #[serde(default)]
    pub messages: Vec<Msg>,
}

/// Résumé pour la liste des discussions.
#[derive(Serialize)]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub contact: String,
    pub updated: u64,
    pub unread: u32,
    pub pinned: bool,
    pub busy: bool,
    pub preview: String,
    pub preview_role: String,
}

static LOCK: Mutex<()> = Mutex::new(());
static RUNNING: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn uid(prefix: &str) -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!("{prefix}{:x}{:x}", now(), N.fetch_add(1, Ordering::SeqCst))
}

fn dir(app: &tauri::AppHandle, profile: &str) -> Result<PathBuf, String> {
    let d = crate::paths::shared_data_dir(app.path())
        .map_err(|e| e.to_string())?
        .join("profiles")
        .join(profile)
        .join("messenger");
    std::fs::create_dir_all(d.join("files")).map_err(|e| e.to_string())?;
    Ok(d)
}

fn read_all(app: &tauri::AppHandle, profile: &str) -> Vec<Thread> {
    let Ok(d) = dir(app, profile) else { return Vec::new() };
    std::fs::read_to_string(d.join("threads.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn write_all(app: &tauri::AppHandle, profile: &str, all: &[Thread]) -> Result<(), String> {
    let d = dir(app, profile)?;
    let tmp = d.join("threads.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, d.join("threads.json")).map_err(|e| e.to_string())
}

/// Modifie une discussion sous verrou, puis diffuse le changement.
fn with_thread<T>(app: &tauri::AppHandle, profile: &str, id: &str, f: impl FnOnce(&mut Thread) -> T) -> Result<T, String> {
    let _g = LOCK.lock().map_err(|e| e.to_string())?;
    let mut all = read_all(app, profile);
    let t = all.iter_mut().find(|t| t.id == id).ok_or("Discussion introuvable")?;
    let out = f(t);
    write_all(app, profile, &all)?;
    Ok(out)
}

fn broadcast(app: &tauri::AppHandle, profile: &str, event: Value) {
    let mut ev = event;
    ev["profile"] = json!(profile);
    let _ = app.emit("messenger", ev.clone());
    let mut phone = ev;
    phone["type"] = json!("messenger");
    crate::companion::push_to_phones(app, phone);
}

fn is_busy(id: &str) -> bool {
    RUNNING.lock().map(|m| m.contains_key(id)).unwrap_or(false)
}

// ===================== Opérations =====================

pub fn list(app: &tauri::AppHandle, profile: &str) -> Vec<ThreadSummary> {
    let mut out: Vec<ThreadSummary> = read_all(app, profile)
        .into_iter()
        .map(|t| {
            let last = t.messages.iter().rev().find(|m| matches!(m.role.as_str(), "user" | "assistant" | "file" | "error"));
            ThreadSummary {
                busy: is_busy(&t.id),
                preview: last.map(|m| if m.role == "file" { m.file.as_ref().map(|f| f.name.clone()).unwrap_or_default() } else { m.text.chars().take(120).collect() }).unwrap_or_default(),
                preview_role: last.map(|m| m.role.clone()).unwrap_or_default(),
                id: t.id,
                title: t.title,
                contact: t.contact,
                updated: t.updated,
                unread: t.unread,
                pinned: t.pinned,
            }
        })
        .collect();
    out.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.updated.cmp(&a.updated)));
    out
}

pub fn get(app: &tauri::AppHandle, profile: &str, id: &str) -> Result<Value, String> {
    let t = read_all(app, profile).into_iter().find(|t| t.id == id).ok_or("Discussion introuvable")?;
    let mut v = serde_json::to_value(&t).map_err(|e| e.to_string())?;
    v["busy"] = json!(is_busy(id));
    Ok(v)
}

pub fn create(app: &tauri::AppHandle, profile: &str, contact: &str, title: &str) -> Result<Value, String> {
    if !contact.is_empty() && !crate::agents::read_agents(app).iter().any(|a| a.id == contact) {
        return Err("Agent introuvable".into());
    }
    let t = Thread { id: uid("th"), title: title.trim().to_string(), contact: contact.to_string(), created: now(), updated: now(), ..Default::default() };
    {
        let _g = LOCK.lock().map_err(|e| e.to_string())?;
        let mut all = read_all(app, profile);
        all.push(t.clone());
        write_all(app, profile, &all)?;
    }
    broadcast(app, profile, json!({ "event": "threads" }));
    serde_json::to_value(&t).map_err(|e| e.to_string())
}

pub fn delete(app: &tauri::AppHandle, profile: &str, id: &str) -> Result<(), String> {
    stop(id);
    {
        let _g = LOCK.lock().map_err(|e| e.to_string())?;
        let mut all = read_all(app, profile);
        if let Some(t) = all.iter().find(|t| t.id == id) {
            // Les pièces jointes partent avec la discussion.
            if let Ok(d) = dir(app, profile) {
                for f in t.messages.iter().filter_map(|m| m.file.as_ref()) {
                    let _ = std::fs::remove_file(d.join("files").join(&f.id));
                }
            }
        }
        all.retain(|t| t.id != id);
        write_all(app, profile, &all)?;
    }
    broadcast(app, profile, json!({ "event": "threads" }));
    Ok(())
}

pub fn update_meta(app: &tauri::AppHandle, profile: &str, id: &str, title: Option<String>, pinned: Option<bool>, read: bool, orchestrate: Option<bool>) -> Result<(), String> {
    with_thread(app, profile, id, |t| {
        if let Some(x) = title { t.title = x.trim().to_string(); }
        if let Some(p) = pinned { t.pinned = p; }
        if let Some(o) = orchestrate { t.orchestrate = o; }
        if read { t.unread = 0; }
    })?;
    broadcast(app, profile, json!({ "event": "threads" }));
    Ok(())
}

/// Coupe le contexte : un séparateur que le modèle ne franchit plus.
pub fn cut(app: &tauri::AppHandle, profile: &str, id: &str) -> Result<Value, String> {
    let m = Msg { id: uid("m"), role: "cut".into(), ts: now(), ..Default::default() };
    let v = serde_json::to_value(&m).map_err(|e| e.to_string())?;
    with_thread(app, profile, id, |t| {
        // Deux coupures d'affilée n'ont pas de sens.
        if t.messages.last().is_some_and(|l| l.role == "cut") { return; }
        t.messages.push(m.clone());
        t.updated = now();
    })?;
    broadcast(app, profile, json!({ "event": "message", "thread": id, "message": v }));
    Ok(v)
}

pub fn stop(id: &str) {
    if let Ok(m) = RUNNING.lock() {
        if let Some(flag) = m.get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

/// Chemin d'une pièce jointe (lecture par le compagnon / le bureau).
pub fn file_path(app: &tauri::AppHandle, profile: &str, file_id: &str) -> Option<(PathBuf, String)> {
    if file_id.contains('/') || file_id.contains("..") { return None; }
    let p = dir(app, profile).ok()?.join("files").join(file_id);
    if !p.is_file() { return None; }
    let mime = match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", "gif" => "image/gif",
        "pdf" => "application/pdf", _ => "application/octet-stream",
    };
    Some((p, mime.to_string()))
}

/// Dépose une pièce jointe dans le fil (image générée, PDF, photo envoyée).
pub fn attach(app: &tauri::AppHandle, profile: &str, thread: &str, bytes: &[u8], name: &str, from: &str, role_user: bool) -> Result<FileRef, String> {
    let ext = name.rsplit('.').next().filter(|e| e.len() <= 5 && *e != name).unwrap_or("bin").to_lowercase();
    let id = format!("{}.{ext}", uid("f"));
    std::fs::write(dir(app, profile)?.join("files").join(&id), bytes).map_err(|e| e.to_string())?;
    let mime = file_path(app, profile, &id).map(|x| x.1).unwrap_or_default();
    let f = FileRef { id, name: name.to_string(), mime };
    let m = Msg { id: uid("m"), role: "file".into(), file: Some(f.clone()), from: if role_user { "me".into() } else { from.to_string() }, ts: now(), ..Default::default() };
    let v = serde_json::to_value(&m).map_err(|e| e.to_string())?;
    with_thread(app, profile, thread, |t| { t.messages.push(m); t.updated = now(); })?;
    broadcast(app, profile, json!({ "event": "message", "thread": thread, "message": v }));
    Ok(f)
}

/// Contacts : Lumen + les agents de l'atelier (avec leur avatar).
pub fn contacts(app: &tauri::AppHandle) -> Vec<Value> {
    let en = crate::telegram::is_en(app);
    let mut out = vec![json!({ "id": "", "name": "Lumen", "description": if en { "Your assistant, with all its tools" } else { "Ton assistant, avec tous ses outils" } })];
    for a in crate::agents::read_agents(app) {
        // `voice` : la voix propre de l'agent (« local:<id> » Piper/Kokoro,
        // « system:<nom> »), utilisée par le mode vocal pour lire SES réponses.
        out.push(json!({ "id": a.id, "name": a.name, "description": a.description, "avatar": a.avatar, "voice": a.voice }));
    }
    out
}

// ===================== Tour de conversation =====================

fn data_url_bytes(url: &str) -> Option<(Vec<u8>, String)> {
    use base64::Engine;
    let (head, b64) = url.split_once(',')?;
    let mime = head.strip_prefix("data:")?.split(';').next()?.to_string();
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    Some((bytes, mime))
}

/// Envoie un message de l'utilisateur et lance la réponse en arrière-plan.
pub fn send(app: &tauri::AppHandle, profile: &str, thread: &str, text: &str, images: Vec<String>) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() && images.is_empty() {
        return Err("Message vide".into());
    }
    if is_busy(thread) {
        return Err("Une réponse est déjà en cours dans cette discussion.".into());
    }
    // Photos jointes : gardées dans le fil ET transmises au modèle (vision).
    let mut b64s = Vec::new();
    for (i, url) in images.iter().enumerate() {
        if let Some((bytes, mime)) = data_url_bytes(url) {
            let ext = match mime.as_str() { "image/png" => "png", "image/webp" => "webp", _ => "jpg" };
            attach(app, profile, thread, &bytes, &format!("photo-{}.{ext}", i + 1), "", true)?;
            use base64::Engine;
            b64s.push((base64::engine::general_purpose::STANDARD.encode(&bytes), mime));
        }
    }
    let m = Msg { id: uid("m"), role: "user".into(), text: text.clone(), ts: now(), ..Default::default() };
    let v = serde_json::to_value(&m).map_err(|e| e.to_string())?;
    with_thread(app, profile, thread, |t| {
        if t.title.is_empty() && !text.is_empty() {
            t.title = text.chars().take(48).collect::<String>().trim().to_string();
        }
        t.messages.push(m);
        t.updated = now();
    })?;
    broadcast(app, profile, json!({ "event": "message", "thread": thread, "message": v }));

    let flag = Arc::new(AtomicBool::new(false));
    RUNNING.lock().map_err(|e| e.to_string())?.insert(thread.to_string(), flag.clone());
    broadcast(app, profile, json!({ "event": "typing", "thread": thread, "on": true }));
    let (app2, profile2, thread2) = (app.clone(), profile.to_string(), thread.to_string());
    tauri::async_runtime::spawn(async move {
        let outcome = turn(&app2, &profile2, &thread2, b64s, flag).await;
        if let Ok(mut m) = RUNNING.lock() { m.remove(&thread2); }
        if let Err(e) = outcome {
            push_msg(&app2, &profile2, &thread2, Msg { id: uid("m"), role: "error".into(), text: e, ts: now(), ..Default::default() });
        }
        broadcast(&app2, &profile2, json!({ "event": "typing", "thread": thread2, "on": false }));
    });
    Ok(v)
}

fn push_msg(app: &tauri::AppHandle, profile: &str, thread: &str, m: Msg) {
    let v = serde_json::to_value(&m).unwrap_or(Value::Null);
    let _ = with_thread(app, profile, thread, |t| { t.messages.push(m); t.updated = now(); });
    broadcast(app, profile, json!({ "event": "message", "thread": thread, "message": v }));
}

fn replace_msg(app: &tauri::AppHandle, profile: &str, thread: &str, m: Msg) {
    let v = serde_json::to_value(&m).unwrap_or(Value::Null);
    let id = m.id.clone();
    let _ = with_thread(app, profile, thread, |t| {
        if let Some(x) = t.messages.iter_mut().find(|x| x.id == id) { *x = m; }
    });
    broadcast(app, profile, json!({ "event": "message", "thread": thread, "message": v, "replace": true }));
}

fn style_rules(en: bool) -> &'static str {
    if en {
        "You are chatting in a messaging app, on a phone. Reply like a helpful friend texting: short, warm, natural, no long headings. \
         Use a short list only when it really helps. When a request needs fresh data or an action, use your tools, then answer with the result. \
         If something is missing, ask one short question."
    } else {
        "Tu discutes dans une messagerie, sur téléphone. Réponds comme un ami serviable qui écrit un message : court, chaleureux, naturel, sans grands titres. \
         Une courte liste seulement si elle aide vraiment. Quand une demande exige une donnée fraîche ou une action, utilise tes outils puis réponds avec le résultat. \
         S'il manque une information, pose UNE question courte."
    }
}

/// Outils du contact d'un fil : ceux de Lumen (Telegram/Messages) ou les
/// outils natifs de l'agent.
async fn contact_tools(app: &tauri::AppHandle, agent: Option<&crate::agents::Agent>, en: bool) -> Vec<Value> {
    match agent {
        None => crate::telegram::all_tool_specs(app, &crate::telegram::read_config(app)).await,
        Some(a) => crate::native_tools::specs(&a.native_tools, en),
    }
}

/// Liste {name, description} pour le menu « @ » des clients.
pub async fn tools_for(app: &tauri::AppHandle, profile: &str, thread: &str) -> Result<Vec<Value>, String> {
    let en = crate::telegram::is_en(app);
    let t = read_all(app, profile).into_iter().find(|t| t.id == thread).ok_or("Discussion introuvable")?;
    let agent = if t.contact.is_empty() { None } else { crate::agents::read_agents(app).into_iter().find(|a| a.id == t.contact) };
    let tools = contact_tools(app, agent.as_ref(), en).await;
    Ok(tools
        .iter()
        .filter_map(|t| {
            let f = t.get("function")?;
            let desc: String = f["description"].as_str().unwrap_or("").chars().take(140).collect();
            Some(json!({ "name": f["name"].as_str()?, "description": desc }))
        })
        .collect())
}

/// Noms d'outils mentionnés avec « @nom » dans un message (nom exact, début
/// de mot), restreints aux outils disponibles.
fn mentioned_tools(text: &str, tools: &[Value]) -> Vec<String> {
    let names: Vec<&str> = tools.iter().filter_map(|t| t.pointer("/function/name").and_then(|v| v.as_str())).collect();
    let mut out: Vec<String> = Vec::new();
    let mut prev = ' ';
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' && (prev.is_whitespace() || i == 0) {
            let word: String = chars[i + 1..].iter().take_while(|c| c.is_alphanumeric() || **c == '_' || **c == '-' || **c == '.').collect();
            if let Some(n) = names.iter().find(|n| n.eq_ignore_ascii_case(&word)) {
                if !out.iter().any(|o| o == n) {
                    out.push(n.to_string());
                }
            }
            i += 1 + word.chars().count();
            prev = 'x';
            continue;
        }
        prev = chars[i];
        i += 1;
    }
    out
}

/// Signaux forts : un « direct » du petit modèle de décision est contredit
/// quand la demande touche manifestement une donnée fraîche ou personnelle.
pub(crate) fn strong_signal(text: &str) -> bool {
    const KEYS: &[&str] = &[
        "météo", "meteo", "weather", "forecast", "prévision", "mail", "courriel", "inbox", "agenda", "calendrier",
        "calendar", "rendez-vous", "rappel", "rappelle-moi", "remind", "score", "actualité", "actualite", "news",
        "cherche sur", "recherche sur", "search the web", "allume", "éteins", "eteins", "turn on", "turn off",
        "mes notes", "mes fichiers", "my files", "my notes", "souviens", "remember that", "aujourd'hui", "today",
        "demain", "tomorrow", "bourse", "cours de", "trafic",
    ];
    let l = text.to_lowercase();
    KEYS.iter().any(|k| l.contains(k))
}

/// Plusieurs demandes dans un même message → orchestration (MÊME logique que
/// `looksMultiRequest` dans lib/decision.js) : plusieurs questions, liste
/// numérotée, ou au moins deux segments qui commencent par un verbe d'action
/// (séparés par ; / ligne / phrase / puis / ensuite / et).
fn multi_request(text: &str) -> bool {
    const ACTIONS: &[&str] = &[
        "cherche", "recherche", "trouve", "donne", "récupère", "recupere", "lis", "résume", "resume", "envoie", "écris",
        "ecris", "crée", "cree", "ajoute", "planifie", "rappelle", "compare", "traduis", "calcule", "ouvre", "lance",
        "montre", "liste", "explique", "prépare", "prepare", "analyse", "vérifie", "verifie", "regarde", "dis", "fais",
        "mets", "programme", "note", "search", "find", "get", "give", "fetch", "read", "summarize", "summarise", "send",
        "write", "create", "add", "schedule", "remind", "translate", "open", "launch", "show", "list", "explain",
        "analyze", "analyse", "check", "look", "tell", "make", "put", "set",
    ];
    let t = text.trim();
    if t.chars().count() < 20 {
        return false;
    }
    if t.matches('?').count() >= 2 {
        return true;
    }
    let listed = t.lines().filter(|l| {
        let l = l.trim_start();
        l.starts_with("- ") || l.starts_with("* ") || l.starts_with("• ")
            || l.split_once(|c| c == '.' || c == ')').is_some_and(|(n, rest)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) && rest.starts_with(' '))
    }).count();
    if listed >= 2 {
        return true;
    }
    // Découpage sur les séparateurs, puis compte des segments « verbe d'abord ».
    let mut norm = format!(" {} ", t.to_lowercase());
    for sep in [";", "\n", ". ", " puis ", " ensuite ", " then ", " and then ", " after that ", " et ", " and "] {
        norm = norm.replace(sep, "\u{1}");
    }
    norm.split('\u{1}')
        .map(|seg| {
            let mut w = seg.trim().trim_start_matches(|c: char| !c.is_alphabetic());
            for p in ["et ", "puis ", "ensuite ", "aussi ", "also ", "then ", "and "] {
                w = w.strip_prefix(p).unwrap_or(w);
            }
            w.split(|c: char| !c.is_alphanumeric() && c != 'é' && c != 'è').next().unwrap_or("").to_string()
        })
        .filter(|first| ACTIONS.contains(&first.as_str()))
        .count()
        >= 2
}

/// Un appel au modèle sans outil, texte brut nettoyé.
async fn llm_text(app: &tauri::AppHandle, llm: &crate::agents::OllamaConfig, messages: Vec<Value>) -> Result<String, String> {
    let (app2, llm2) = (app.clone(), llm.clone());
    let msg = tokio::task::spawn_blocking(move || crate::agents::chat_messages(&app2, &llm2, &messages, None))
        .await
        .map_err(|e| e.to_string())??;
    Ok(crate::assist::clean(msg.get("content").and_then(|c| c.as_str()).unwrap_or("")))
}

/// Étapes d'un plan : JSON `{"steps":[…]}` attendu, lignes en repli.
fn parse_steps(raw: &str) -> Vec<String> {
    let json_part = raw.find('{').and_then(|a| raw.rfind('}').map(|b| &raw[a..=b]));
    if let Some(v) = json_part.and_then(|j| serde_json::from_str::<Value>(j).ok()) {
        let steps: Vec<String> = v["steps"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
        if !steps.is_empty() {
            return steps.into_iter().take(6).collect();
        }
    }
    raw.lines()
        .map(|l| l.trim().trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')' || c == '-' || c == '*' || c == ' ').trim().to_string())
        .filter(|l| l.len() > 3)
        .take(6)
        .collect()
}

fn stopped(app: &tauri::AppHandle, profile: &str, thread: &str, en: bool) {
    push_msg(app, profile, thread, Msg { id: uid("m"), role: "error".into(), text: if en { "Stopped.".into() } else { "Arrêté.".into() }, ts: now(), ..Default::default() });
}

/// Pastille d'étape (plan, vérification) affichée comme un appel d'outil.
fn step_pill(app: &tauri::AppHandle, profile: &str, thread: &str, from: &str, name: &str, args: Value, result: String, ok: bool) {
    push_msg(app, profile, thread, Msg {
        id: uid("m"), role: "tool".into(), from: from.to_string(), ts: now(),
        tool: Some(ToolCall { name: name.into(), args, result, ok, running: false }),
        ..Default::default()
    });
}

async fn turn(app: &tauri::AppHandle, profile: &str, thread: &str, images: Vec<(String, String)>, cancel: Arc<AtomicBool>) -> Result<(), String> {
    let en = crate::telegram::is_en(app);
    let t = read_all(app, profile).into_iter().find(|t| t.id == thread).ok_or("Discussion introuvable")?;
    let agent = if t.contact.is_empty() { None } else { crate::agents::read_agents(app).into_iter().find(|a| a.id == t.contact) };
    if !t.contact.is_empty() && agent.is_none() {
        return Err(if en { "This agent no longer exists.".into() } else { "Cet agent n'existe plus.".into() });
    }

    // Historique depuis la dernière coupure de contexte.
    let start = t.messages.iter().rposition(|m| m.role == "cut").map(|i| i + 1).unwrap_or(0);
    let mut hist: Vec<Value> = t.messages[start..]
        .iter()
        .filter_map(|m| match m.role.as_str() {
            "user" => Some(json!({ "role": "user", "content": m.text })),
            "assistant" => Some(json!({ "role": "assistant", "content": m.text })),
            _ => None,
        })
        .collect();
    if hist.len() > HISTORY_MAX {
        hist.drain(0..hist.len() - HISTORY_MAX);
    }
    let mut users = t.messages[start..].iter().rev().filter(|m| m.role == "user").map(|m| m.text.clone());
    let last_user = users.next().unwrap_or_default();
    let prev_user = users.next().unwrap_or_default();

    let tgc = crate::telegram::read_config(app);
    let all_tools = contact_tools(app, agent.as_ref(), en).await;
    let (llm, system, from) = match &agent {
        None => {
            let route = crate::telegram::Route { backend: "lumen".into(), model: String::new(), mode: "tools".into() };
            let llm = crate::telegram::llm_config(app, &route);
            let base = format!("{}\n\n{}", if en { "You are Lumen, the user's personal assistant." } else { "Tu es Lumen, l'assistant personnel de l'utilisateur." }, style_rules(en));
            let system = crate::telegram::system_prompt(app, "messenger.lumen", &base, en).await;
            (llm, system, String::new())
        }
        Some(a) => {
            let (app2, a2) = (app.clone(), a.clone());
            let llm = tokio::task::spawn_blocking(move || crate::agents::agent_llm_config(&app2, &a2)).await.map_err(|e| e.to_string())?;
            let today = chrono::Local::now().format("%A %d/%m/%Y %H:%M");
            let place = crate::live_data::default_place();
            let system = format!(
                "{}\n\n{}{}\n{}",
                crate::agents::instruction_with_variables(a.instruction.trim(), &a.variables),
                if en { format!("You are {}. Today: {today}.", a.name) } else { format!("Tu es {}. Nous sommes le {today}.", a.name) },
                if place.is_empty() { String::new() } else if en { format!(" User's usual location: {place}.") } else { format!(" Lieu habituel de l'utilisateur : {place}.") },
                style_rules(en)
            );
            (llm, system, a.id.clone())
        }
    };

    // ---- Aiguillage de départ ----
    // 1. « @outil » : l'utilisateur impose les outils ; 2. bouton orchestré du
    // fil : orchestration forcée ; 3. sinon moteur de décision (Tev1) ; repli
    // historique (tous les outils) s'il est absent ou indécis.
    let mentioned = mentioned_tools(&last_user, &all_tools);
    let has_tools = !all_tools.is_empty();
    let route: String = if !mentioned.is_empty() {
        "tools".into()
    } else if t.orchestrate {
        "orchestrate".into()
    } else if !images.is_empty() {
        if has_tools { "tools".into() } else { "direct".into() }
    } else if multi_request(&last_user) {
        // Plusieurs demandes : chacune doit être planifiée et vérifiée.
        "orchestrate".into()
    } else {
        match crate::llama::auto_route(app, &last_user, &prev_user, has_tools).await {
            Some(r) if r == "direct" && has_tools && strong_signal(&last_user) => "tools".into(),
            Some(r) => r,
            None => if has_tools { "tools".into() } else { "direct".into() },
        }
    };
    let tools: Vec<Value> = match route.as_str() {
        "direct" => Vec::new(),
        "tools" if !mentioned.is_empty() => all_tools
            .iter()
            .filter(|t| t.pointer("/function/name").and_then(|v| v.as_str()).is_some_and(|n| mentioned.iter().any(|m| m == n)))
            .cloned()
            .collect(),
        _ => all_tools.clone(),
    };

    let api = llm.is_openai_compatible();
    let mut system = system;
    if !mentioned.is_empty() {
        let list = mentioned.iter().map(|n| format!("@{n}")).collect::<Vec<_>>().join(", ");
        system.push_str(&if en {
            format!("\n\nThe user explicitly asks you to use: {list}. Call these tools before answering.")
        } else {
            format!("\n\nL'utilisateur demande explicitement : {list}. Appelle ces outils avant de répondre.")
        });
    }

    // ---- Orchestration : plan ----
    let orchestrated = route == "orchestrate";
    let mut steps: Vec<String> = Vec::new();
    if orchestrated {
        let names: Vec<&str> = tools.iter().filter_map(|t| t.pointer("/function/name").and_then(|v| v.as_str())).collect();
        let planner = if en {
            "You plan the work of an assistant. Split the user's request into 2 to 5 short, concrete steps (gather data with tools, compare, then write). Reply ONLY with JSON: {\"steps\": [\"...\"]}"
        } else {
            "Tu planifies le travail d'un assistant. Découpe la demande en 2 à 5 étapes courtes et concrètes (collecter les données avec les outils, comparer, puis rédiger). Réponds UNIQUEMENT en JSON : {\"steps\": [\"...\"]}"
        };
        let user = format!(
            "{}{}\n\n{}: {}",
            if prev_user.is_empty() { String::new() } else if en { format!("Previous message: {prev_user}\n") } else { format!("Message précédent : {prev_user}\n") },
            if en { format!("Request: {last_user}") } else { format!("Demande : {last_user}") },
            if en { "Available tools" } else { "Outils disponibles" },
            if names.is_empty() { "-".to_string() } else { names.join(", ") }
        );
        let planner = crate::prompts::resolve(app, if en { "messenger.planner.en" } else { "messenger.planner.fr" }, planner);
        let raw = llm_text(app, &llm, vec![json!({ "role": "system", "content": planner }), json!({ "role": "user", "content": user })]).await.unwrap_or_default();
        steps = parse_steps(&raw);
        if cancel.load(Ordering::SeqCst) {
            stopped(app, profile, thread, en);
            return Ok(());
        }
        if !steps.is_empty() {
            let listing = steps.iter().enumerate().map(|(i, s)| format!("{}. {s}", i + 1)).collect::<Vec<_>>().join("\n");
            step_pill(app, profile, thread, &from, "orchestrate_plan", json!({ "steps": steps }), listing.clone(), true);
            system.push_str(&if en {
                format!("\n\nFollow this plan, step by step, using your tools for every fact you need, then write one complete answer:\n{listing}")
            } else {
                format!("\n\nSuis ce plan, étape par étape, en utilisant tes outils pour chaque fait nécessaire, puis rédige UNE réponse complète :\n{listing}")
            });
        }
    }

    let mut messages = vec![json!({ "role": "system", "content": system })];
    messages.extend(hist);
    // Photos du dernier message : format Ollama (`images`) ou OpenAI (parties).
    if !images.is_empty() {
        if let Some(last) = messages.iter_mut().rev().find(|m| m["role"] == "user") {
            let text = last["content"].as_str().unwrap_or("").to_string();
            if api {
                let mut parts = vec![json!({ "type": "text", "text": if text.is_empty() { "(photo)".to_string() } else { text } })];
                for (b, mime) in &images {
                    parts.push(json!({ "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{b}") } }));
                }
                last["content"] = json!(parts);
            } else {
                last["images"] = json!(images.iter().map(|(b, _)| b.clone()).collect::<Vec<_>>());
            }
        }
    }

    let dest = crate::telegram::Dest::Messenger { profile: profile.to_string(), thread: thread.to_string(), from: from.clone() };
    let rounds = if orchestrated { MAX_ROUNDS * 2 } else { MAX_ROUNDS };
    let mut evidence: Vec<String> = Vec::new();
    let mut final_text: Option<String> = None;
    for _ in 0..rounds {
        if cancel.load(Ordering::SeqCst) {
            stopped(app, profile, thread, en);
            return Ok(());
        }
        let (app2, llm2, msgs, tools2) = (app.clone(), llm.clone(), messages.clone(), tools.clone());
        let msg = tokio::task::spawn_blocking(move || {
            crate::agents::chat_messages(&app2, &llm2, &msgs, if tools2.is_empty() { None } else { Some(tools2.as_slice()) })
        })
        .await
        .map_err(|e| e.to_string())??;
        if cancel.load(Ordering::SeqCst) {
            stopped(app, profile, thread, en);
            return Ok(());
        }
        let calls = msg.get("tool_calls").and_then(|c| c.as_array()).cloned().unwrap_or_default();
        if calls.is_empty() {
            final_text = Some(crate::assist::clean(msg.get("content").and_then(|c| c.as_str()).unwrap_or("")));
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
            // Bulle d'outil « en cours », complétée à la fin de l'appel.
            let mut tm = Msg { id: uid("m"), role: "tool".into(), from: from.clone(), ts: now(), tool: Some(ToolCall { name: name.clone(), args: args.clone(), running: true, ..Default::default() }), ..Default::default() };
            push_msg(app, profile, thread, tm.clone());
            let allowed = tools.iter().any(|t| t.pointer("/function/name").and_then(|v| v.as_str()) == Some(&name));
            let (result, ok) = if !allowed {
                (format!("Outil indisponible : {name}"), false)
            } else if agent.is_some() {
                crate::native_tools::exec(app, &name, &args, agent.as_ref().map(|a| a.sandbox_id.as_str()).unwrap_or("")).await
            } else {
                let r = crate::telegram::exec_tool_to(app, &tgc, &dest, &name, &args).await;
                let ok = !(r.starts_with("Erreur") || r.starts_with("Error") || r.starts_with("Outil inconnu"));
                (r, ok)
            };
            if let Some(tc) = tm.tool.as_mut() {
                tc.running = false;
                tc.ok = ok;
                tc.result = crate::telegram::truncate(&crate::telegram::redact(app, &tgc, &result), 1200);
            }
            replace_msg(app, profile, thread, tm);
            evidence.push(format!("[{name}] {}", crate::telegram::truncate(&result, 1500)));
            let mut tool_msg = json!({ "role": "tool", "name": name, "content": crate::telegram::truncate(&result, 4000) });
            if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                tool_msg["tool_call_id"] = json!(id);
            }
            messages.push(tool_msg);
        }
    }
    let Some(mut text) = final_text else {
        return Err(if en { "Too many steps for this request — try phrasing it more simply.".into() } else { "Trop d'étapes pour cette demande — reformule-la plus simplement.".into() });
    };

    // ---- Orchestration : vérification (réécriture si incomplet/non fondé) ----
    if orchestrated && !text.is_empty() && !cancel.load(Ordering::SeqCst) {
        let checker = if en {
            "You check an assistant's answer. Given the request, the plan, the tool results and the draft answer: if the draft fully answers every part, is consistent with the tool results and invents nothing, reply exactly OK. Otherwise reply with the corrected full answer only (same short messaging style)."
        } else {
            "Tu vérifies la réponse d'un assistant. Avec la demande, le plan, les résultats d'outils et le brouillon : si le brouillon répond à chaque partie, est cohérent avec les résultats et n'invente rien, réponds exactement OK. Sinon réponds uniquement par la réponse complète corrigée (même style court de messagerie)."
        };
        let body = format!(
            "{}: {last_user}\n\n{}:\n{}\n\n{}:\n{}\n\n{}:\n{text}",
            if en { "Request" } else { "Demande" },
            if en { "Plan" } else { "Plan" },
            if steps.is_empty() { "-".to_string() } else { steps.join("\n") },
            if en { "Tool results" } else { "Résultats d'outils" },
            if evidence.is_empty() { "-".to_string() } else { evidence.join("\n").chars().take(8000).collect() },
            if en { "Draft" } else { "Brouillon" },
        );
        let checker = crate::prompts::resolve(app, if en { "messenger.checker.en" } else { "messenger.checker.fr" }, checker);
        if let Ok(verdict) = llm_text(app, &llm, vec![json!({ "role": "system", "content": checker }), json!({ "role": "user", "content": body })]).await {
            let v = verdict.trim();
            let ok = v.is_empty() || v.trim_matches(|c: char| !c.is_alphanumeric()).eq_ignore_ascii_case("ok");
            if !ok && v.len() > 20 {
                text = v.to_string();
            }
            step_pill(app, profile, thread, &from, "orchestrate_check", json!({}), if ok { "OK".into() } else if en { "Answer revised".into() } else { "Réponse révisée".into() }, true);
        }
    }

    let text = if text.is_empty() { if en { "(no answer)".into() } else { "(pas de réponse)".into() } } else { crate::telegram::redact(app, &tgc, &text) };
    push_msg(app, profile, thread, Msg { id: uid("m"), role: "assistant".into(), text: text.clone(), from: from.clone(), ts: now(), ..Default::default() });
    let _ = with_thread(app, profile, thread, |t| t.unread += 1);
    // Notification : la réponse arrive souvent quand on a quitté l'app.
    let who = agent.as_ref().map(|a| a.name.clone()).unwrap_or_else(|| "Lumen".into());
    crate::push::notify_detached(app, Some(profile.to_string()), who, text.chars().take(140).collect(), format!("/?messages={thread}"));
    Ok(())
}

/// Raccourcis : envoie un message et ATTEND la réponse (fil existant ou
/// nouveau fil avec `contact`). Renvoie (fil, réponse).
pub async fn ask_and_wait(app: &tauri::AppHandle, profile: &str, contact: &str, thread: Option<String>, text: &str) -> Result<(String, String), String> {
    let thread = match thread.filter(|t| !t.is_empty()) {
        Some(t) => t,
        None => create(app, profile, contact, "")?["id"].as_str().unwrap_or("").to_string(),
    };
    let before = read_all(app, profile).into_iter().find(|t| t.id == thread).map(|t| t.messages.len()).unwrap_or(0);
    send(app, profile, &thread, text, Vec::new())?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(240);
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        if !is_busy(&thread) || std::time::Instant::now() > deadline { break; }
    }
    let t = read_all(app, profile).into_iter().find(|t| t.id == thread).ok_or("Discussion introuvable")?;
    let reply = t.messages.iter().skip(before).rev().find(|m| m.role == "assistant" || m.role == "error").map(|m| m.text.clone());
    match reply {
        Some(r) => Ok((thread, r)),
        None => Err("Pas de réponse (délai dépassé).".into()),
    }
}

// ===================== Commandes du bureau =====================

fn active(app: &tauri::AppHandle) -> String {
    crate::session::active_profile_id(app)
}

#[tauri::command]
pub fn messenger_contacts(app: tauri::AppHandle) -> Vec<Value> {
    contacts(&app)
}
#[tauri::command]
pub fn messenger_threads(app: tauri::AppHandle) -> Vec<ThreadSummary> {
    list(&app, &active(&app))
}
#[tauri::command]
pub fn messenger_thread(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    get(&app, &active(&app), &id)
}
#[tauri::command]
pub fn messenger_new(app: tauri::AppHandle, contact: String, title: Option<String>) -> Result<Value, String> {
    create(&app, &active(&app), &contact, title.as_deref().unwrap_or(""))
}
#[tauri::command]
pub fn messenger_send(app: tauri::AppHandle, thread: String, text: String, images: Option<Vec<String>>) -> Result<Value, String> {
    send(&app, &active(&app), &thread, &text, images.unwrap_or_default())
}
#[tauri::command]
pub fn messenger_cut(app: tauri::AppHandle, thread: String) -> Result<Value, String> {
    cut(&app, &active(&app), &thread)
}
#[tauri::command]
pub fn messenger_stop(thread: String) {
    stop(&thread)
}
#[tauri::command]
pub fn messenger_delete(app: tauri::AppHandle, thread: String) -> Result<(), String> {
    delete(&app, &active(&app), &thread)
}
#[tauri::command]
pub fn messenger_update(app: tauri::AppHandle, thread: String, title: Option<String>, pinned: Option<bool>, read: Option<bool>, orchestrate: Option<bool>) -> Result<(), String> {
    update_meta(&app, &active(&app), &thread, title, pinned, read.unwrap_or(false), orchestrate)
}
/// Outils mentionnables avec « @ » dans un fil (ceux de Lumen ou de l'agent).
#[tauri::command]
pub async fn messenger_tools(app: tauri::AppHandle, thread: String) -> Result<Vec<Value>, String> {
    tools_for(&app, &active(&app), &thread).await
}
/// Pièce jointe en data URL (le bureau n'a pas de serveur de fichiers).
#[tauri::command]
pub fn messenger_file(app: tauri::AppHandle, id: String) -> Result<String, String> {
    use base64::Engine;
    let (p, mime) = file_path(&app, &active(&app), &id).ok_or("Fichier introuvable")?;
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_url_is_decoded() {
        let (b, m) = data_url_bytes("data:image/png;base64,aGVsbG8=").unwrap();
        assert_eq!(b, b"hello");
        assert_eq!(m, "image/png");
        assert!(data_url_bytes("pas une url").is_none());
    }
}

#[cfg(test)]
mod routing_tests {
    use super::*;

    fn tool(n: &str) -> Value { json!({ "type": "function", "function": { "name": n, "description": "" } }) }

    #[test]
    fn mentions_exactes_et_en_debut_de_mot() {
        let tools = vec![tool("weather_now"), tool("mail_search")];
        assert_eq!(mentioned_tools("@weather_now à Paris", &tools), vec!["weather_now"]);
        assert_eq!(mentioned_tools("lis @mail_search puis @weather_now @weather_now", &tools), vec!["mail_search", "weather_now"]);
        assert!(mentioned_tools("ecris a moi@weather_now.fr", &tools).is_empty());
        assert!(mentioned_tools("@inconnu", &tools).is_empty());
    }

    #[test]
    fn etapes_json_ou_lignes() {
        assert_eq!(parse_steps("ok {\"steps\": [\"A faire\", \"B faire\"]}"), vec!["A faire", "B faire"]);
        assert_eq!(parse_steps("1. Chercher la météo\n2. Comparer"), vec!["Chercher la météo", "Comparer"]);
    }

    #[test]
    fn demandes_multiples() {
        assert!(multi_request("Donne-moi la météo et lis mes mails non lus"));
        assert!(multi_request("Récupère le cours du Bitcoin puis lance une recherche web sur les Dots"));
        assert!(multi_request("Quel temps fait-il ? Et qu'ai-je à l'agenda demain ?"));
        assert!(multi_request("1. Résume mes mails\n2. Crée un rappel pour 18h"));
        assert!(multi_request("Get the weather in Paris and summarize my emails"));
        assert!(!multi_request("Quel temps fait-il à Paris et à Lyon ?"));
        assert!(!multi_request("Explique-moi la photosynthèse et ses étapes"));
        assert!(!multi_request("Écris un poème sur la mer et le vent"));
        assert!(!multi_request("Compare la météo de Paris et de Lyon"));
    }

    #[test]
    fn signaux_forts() {
        assert!(strong_signal("Quel temps fait-il ? météo"));
        assert!(!strong_signal("Écris un poème"));
    }
}
