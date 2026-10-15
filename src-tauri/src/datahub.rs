//! Coffre unifié : UNE source de données pour l'IA et les agents.
//!
//! Chaque app range ses données à sa façon (kanban.json, reminders.json,
//! app-state/notes.json, mail.json, tables.db, rag.db, coffre clé → valeur de
//! l'iPhone…). Ici, des CONNECTEURS les traduisent en fiches normalisées :
//!
//! ```text
//! { id: "kanban:gmsuy5sq", app: "kanban", type: "task", title, text,
//!   start, end, status, tags, people, place, ref }
//! ```
//!
//! rangées dans un index SQLite plein texte (`vault/hub.db`, FTS5, accents
//! ignorés). Les outils `data_*` y accèdent de plusieurs façons — recherche,
//! agenda, tâches, mesures, fiche complète, inventaire — depuis le chat, les
//! agents, le compagnon, l'app iOS et Lumen XR (tous passent par Rust).
//!
//! ## Fraîcheur
//! Chaque connecteur a une SIGNATURE (date de modification + taille des
//! fichiers lus). Un balayage toutes les 15 s réindexe les sources dont la
//! signature a changé ; le coffre clé → valeur et `app_state_save` demandent un
//! réindexage immédiat (`touch`). Aucun module d'app n'a à connaître ce fichier.
//!
//! ## Contenu et adresses
//! Le TEXTE est indexé en entier (100 Ko par fiche) : notes, documents des
//! sandboxes (Markdown, texte, code, CSV, PDF, Word, Excel, PowerPoint,
//! OpenDocument, HTML), documents Opus/Keynote/Calc de Lumen (.lumenpages,
//! .lumenkey, .lumensheet), documents du Corpus. Une extraction coûteuse (PDF…)
//! est gardée en cache tant que le fichier ne change pas (table `filecache`).
//! Ce qui ne se range pas en texte — images, audio, vidéo, archives, binaires —
//! devient une fiche avec une ADRESSE (`url`) : `lumenmedia://localhost/<sandbox>/<chemin>`.
//! Le bureau l'affiche telle quelle (images) ou l'ouvre (`datahub_open_file`) ;
//! le compagnon, l'app iOS et XR la réécrivent vers `/media/<sandbox>/<chemin>`
//! du serveur compagnon (jeton requis).
//!
//! ## Confidentialité
//! Chaque source se coupe dans les réglages (`hub-settings.json`), chaque
//! sandbox aussi (`excluded_sandboxes`). Les fiches du coffre clé → valeur
//! sont rangées par profil. Les adresses ne servent un fichier que session
//! déverrouillée.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

// ===================== Modèle =====================

/// Une fiche normalisée. `start`/`end` en ms (0 = sans date).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Rec {
    pub id: String,
    pub app: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub start: i64,
    #[serde(default)]
    pub end: i64,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub tags: String,
    #[serde(default)]
    pub people: String,
    #[serde(default)]
    pub place: String,
    /// Où la retrouver : chemin de sandbox, clé du coffre, id de base…
    #[serde(default, rename = "ref")]
    pub rref: String,
    /// Adresse du fichier d'origine (image, PDF, binaire…), vide sinon.
    #[serde(default)]
    pub url: String,
    /// Extrait surligné autour du passage trouvé (recherche plein texte).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub hit: String,
    #[serde(default)]
    pub updated: i64,
}

/// Types de fiches, avec leur libellé pour le modèle.
pub const TYPES: &[(&str, &str, &str)] = &[
    ("event", "évènement", "event"),
    ("task", "tâche / rappel", "task / reminder"),
    ("note", "note", "note"),
    ("contact", "contact", "contact"),
    ("message", "message / courriel", "message / email"),
    ("file", "fichier", "file"),
    ("document", "document", "document"),
    ("image", "image", "image"),
    ("media", "audio / vidéo", "audio / video"),
    ("table", "table de données", "data table"),
    ("metric", "mesure (santé, compteur…)", "measurement (health, counter…)"),
    ("list", "liste", "list"),
    ("value", "valeur", "value"),
    ("agent", "agent", "agent"),
    ("item", "élément d'app", "app item"),
];

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Nombre → ms (secondes acceptées) ; chaîne ISO ou RFC 2822 → ms.
pub fn to_ms(v: &Value) -> i64 {
    match v {
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(0.0) as i64;
            if x > 0 && x < 100_000_000_000 { x * 1000 } else { x.max(0) }
        }
        Value::String(s) => parse_date(s),
        _ => 0,
    }
}

pub fn parse_date(s: &str) -> i64 {
    let s = s.trim();
    if s.is_empty() {
        return 0;
    }
    if let Ok(n) = s.parse::<f64>() {
        return to_ms(&json!(n));
    }
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) {
        return d.timestamp_millis();
    }
    if let Ok(d) = chrono::DateTime::parse_from_rfc2822(s) {
        return d.timestamp_millis();
    }
    for f in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(d) = chrono::NaiveDateTime::parse_from_str(s, f) {
            return d.and_local_timezone(chrono::Local).single().map(|x| x.timestamp_millis()).unwrap_or(0);
        }
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s.get(..10).unwrap_or(s), "%Y-%m-%d") {
        return d.and_hms_opt(0, 0, 0).and_then(|x| x.and_local_timezone(chrono::Local).single()).map(|x| x.timestamp_millis()).unwrap_or(0);
    }
    0
}

pub fn fmt_date(ms: i64, en: bool) -> String {
    if ms <= 0 {
        return String::new();
    }
    let Some(d) = chrono::DateTime::from_timestamp_millis(ms) else { return String::new() };
    let d = d.with_timezone(&chrono::Local);
    use chrono::{Datelike, Timelike};
    const JF: [&str; 7] = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
    const JE: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let wd = d.weekday().num_days_from_monday() as usize;
    let time = if d.hour() == 0 && d.minute() == 0 { String::new() } else { format!(" {:02}:{:02}", d.hour(), d.minute()) };
    if en {
        format!("{} {}/{:02}/{}{time}", JE[wd], d.day(), d.month(), d.year())
    } else {
        format!("{} {:02}/{:02}/{}{time}", JF[wd], d.day(), d.month(), d.year())
    }
}

fn s(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(x)) => x.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

/// Plafond d'une fiche indexée (texte intégral jusqu'à 100 Ko).
const TEXT_CAP: usize = 100 * 1024;

fn cap(t: &str) -> String {
    if t.len() <= TEXT_CAP {
        return t.to_string();
    }
    let mut end = TEXT_CAP;
    while !t.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &t[..end])
}

/// Adresse d'un fichier de sandbox : `lumenmedia://localhost/<sb>/<chemin encodé>`.
pub fn media_url(sb: &str, rel: &str) -> String {
    let enc: String = rel
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    format!("lumenmedia://localhost/{sb}/{enc}")
}

fn clip(t: &str, max: usize) -> String {
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= max {
        t
    } else {
        format!("{}…", t.chars().take(max).collect::<String>())
    }
}

/// JSON éventuellement stocké en chaîne (app-state).
fn unstring(v: Value) -> Value {
    match v {
        Value::String(ref x) if x.trim_start().starts_with(['[', '{']) => serde_json::from_str(x).unwrap_or(v),
        other => other,
    }
}

// ===================== Réglages =====================

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HubSettings {
    /// Sources coupées (ids de connecteurs, ex. « courrier »).
    #[serde(default)]
    pub disabled: Vec<String>,
    /// Sandboxes laissées HORS du coffre (toutes y sont par défaut).
    #[serde(default)]
    pub excluded_sandboxes: Vec<String>,
}

fn data_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    crate::paths::shared_data_dir(app.path()).ok()
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(data_dir(app)?.join("vault").join("hub-settings.json"))
}

pub fn settings(app: &tauri::AppHandle) -> HubSettings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

// ===================== Connecteurs =====================

/// Un connecteur : ses fichiers (pour la signature) et son lecteur.
struct Source {
    id: String,
    label_fr: String,
    label_en: String,
    /// "*" = commun à tous les profils ; sinon id de profil.
    scope: String,
    files: Vec<PathBuf>,
    read: Box<dyn Fn(&tauri::AppHandle) -> Vec<Rec> + Send>,
}

fn read_json(p: &Path) -> Value {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

/// app-state : `{ clé: "<JSON en chaîne>" }` → `{ clé: valeur }`.
fn read_state(p: &Path) -> BTreeMap<String, Value> {
    match read_json(p) {
        Value::Object(m) => m.into_iter().map(|(k, v)| (k, unstring(v))).collect(),
        _ => BTreeMap::new(),
    }
}

fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

fn kanban(p: &Path) -> Vec<Rec> {
    let b = read_json(p);
    let cols: HashMap<String, String> = arr(&b["columns"]).iter().map(|c| (s(c, "id"), s(c, "title"))).collect();
    let who: HashMap<String, String> = arr(&b["members"]).iter().map(|m| (s(m, "id"), s(m, "name"))).collect();
    let last_col = arr(&b["columns"]).last().map(|c| s(c, "id")).unwrap_or_default();
    arr(&b["cards"])
        .iter()
        .map(|c| {
            let col = s(c, "colId");
            let file = &c["file"];
            let comments = arr(&c["comments"]).iter().map(|x| x.get("text").or(x.get("body")).and_then(|t| t.as_str()).unwrap_or("").to_string()).filter(|x| !x.is_empty()).collect::<Vec<_>>();
            Rec {
                id: format!("kanban:{}", s(c, "id")),
                app: "kanban".into(),
                kind: "task".into(),
                title: s(c, "title"),
                text: [s(c, "desc"), comments.join(" | ")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" · "),
                start: to_ms(&c["due"]),
                status: if !last_col.is_empty() && col == last_col { format!("fait ({})", cols.get(&col).cloned().unwrap_or_default()) } else { cols.get(&col).cloned().unwrap_or_default() },
                tags: arr(&c["labels"]).iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", "),
                people: who.get(&s(c, "assignee")).cloned().unwrap_or_default(),
                rref: if file.is_object() { format!("{}/{}", s(file, "sandboxName"), s(file, "path")) } else { String::new() },
                url: if file.is_object() && !s(file, "sandboxId").is_empty() { media_url(&s(file, "sandboxId"), &s(file, "path")) } else { String::new() },
                updated: to_ms(&c["created"]),
                ..Default::default()
            }
        })
        .collect()
}

fn reminders(p: &Path) -> Vec<Rec> {
    arr(&read_json(p))
        .iter()
        .map(|r| Rec {
            id: format!("rappels:{}", s(r, "id")),
            app: "rappels".into(),
            kind: "task".into(),
            title: s(r, "title"),
            text: [s(r, "note"), if s(r, "recur").is_empty() || s(r, "recur") == "none" { String::new() } else { format!("récurrence : {}", s(r, "recur")) }].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" · "),
            start: to_ms(&r["due_at"]),
            status: if r["done"].as_bool() == Some(true) { "fait".into() } else { "à faire".into() },
            updated: to_ms(&r["created_at"]),
            ..Default::default()
        })
        .collect()
}

fn contacts(p: &Path) -> Vec<Rec> {
    arr(&read_json(p))
        .iter()
        .map(|c| Rec {
            id: format!("contacts:{}", s(c, "id")),
            app: "contacts".into(),
            kind: "contact".into(),
            title: if s(c, "name").is_empty() { s(c, "email") } else { s(c, "name") },
            text: ["email", "phone", "company", "role", "address", "note", "birthday"].iter().map(|k| (k, s(c, k))).filter(|(_, v)| !v.is_empty()).map(|(k, v)| format!("{k} : {v}")).collect::<Vec<_>>().join(" · "),
            tags: s(c, "origin"),
            updated: to_ms(&c["updated_at"]),
            ..Default::default()
        })
        .collect()
}

fn inbox(p: &Path) -> Vec<Rec> {
    arr(&read_json(p))
        .iter()
        .map(|m| Rec {
            id: format!("messagerie:{}", s(m, "id")),
            app: "messagerie".into(),
            kind: "message".into(),
            title: s(m, "subject"),
            text: clip(&s(m, "body"), 1200),
            start: to_ms(&m["ts"]),
            status: if m["read"].as_bool() == Some(true) { "lu".into() } else { "non lu".into() },
            people: s(m, "from"),
            updated: to_ms(&m["ts"]),
            ..Default::default()
        })
        .collect()
}

fn mail(p: &Path) -> Vec<Rec> {
    arr(&read_json(p))
        .iter()
        .take(500)
        .map(|m| Rec {
            id: format!("courrier:{}", s(m, "id")),
            app: "courrier".into(),
            kind: "message".into(),
            title: s(m, "subject"),
            text: clip(&s(m, "body").replace("&zwnj;", ""), 600),
            start: if to_ms(&m["ts"]) > 0 { to_ms(&m["ts"]) } else { parse_date(&s(m, "date")) },
            people: [s(m, "from"), s(m, "to")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" → "),
            status: if m["seen"].as_bool() == Some(false) { "non lu".into() } else { String::new() },
            ..Default::default()
        })
        .collect()
}

fn agents(p: &Path) -> Vec<Rec> {
    let mut out = vec![];
    for a in arr(&read_json(p)) {
        let name = s(&a, "name");
        out.push(Rec {
            id: format!("agents:{}", s(&a, "id")),
            app: "agents".into(),
            kind: "agent".into(),
            title: name.clone(),
            text: clip(&[s(&a, "description"), s(&a, "role")].join(" "), 300),
            ..Default::default()
        });
        for (i, t) in arr(&a["tasks"]).iter().enumerate() {
            let text = if t.is_string() { t.as_str().unwrap_or("").to_string() } else { s(t, "text") };
            if text.is_empty() {
                continue;
            }
            out.push(Rec {
                id: format!("agents:{}:{}", s(&a, "id"), if s(t, "id").is_empty() { i.to_string() } else { s(t, "id") }),
                app: "agents".into(),
                kind: "task".into(),
                title: text,
                text: format!("tâche de l'agent {name}"),
                start: to_ms(&t["due"]),
                status: if t["done"].as_bool() == Some(true) { "fait".into() } else { "à faire".into() },
                people: name.clone(),
                ..Default::default()
            });
        }
    }
    out
}

fn notes(p: &Path) -> Vec<Rec> {
    let st = read_state(p);
    arr(st.get("notes.data").unwrap_or(&Value::Null))
        .iter()
        .map(|n| {
            let body = s(n, "body");
            let tags: Vec<String> = body.split_whitespace().filter(|w| w.starts_with('#') && w.len() > 1).map(|w| w.trim_end_matches(|c: char| !c.is_alphanumeric()).to_string()).collect();
            Rec {
                id: format!("notes:{}", s(n, "id")),
                app: "notes".into(),
                kind: "note".into(),
                title: if s(n, "title").is_empty() { "(sans titre)".into() } else { s(n, "title") },
                text: cap(&body),
                tags: tags.join(", "),
                updated: to_ms(&n["ts"]),
                ..Default::default()
            }
        })
        .collect()
}

fn calendar(p: &Path) -> Vec<Rec> {
    let st = read_state(p);
    let names: HashMap<String, String> = arr(st.get("ext.sources").unwrap_or(&Value::Null)).iter().map(|x| (s(x, "id"), s(x, "name"))).collect();
    let mut out = vec![];
    for (k, list) in &st {
        let Some(src) = k.strip_prefix("ext.events.") else { continue };
        let label = names.get(src).cloned().unwrap_or_else(|| "agenda externe".into());
        for e in arr(list) {
            out.push(Rec {
                id: format!("agenda:{src}:{}", if s(&e, "id").is_empty() { s(&e, "uid") } else { s(&e, "id") }),
                app: "agenda".into(),
                kind: "event".into(),
                title: s(&e, "title"),
                text: clip(&s(&e, "description"), 400),
                start: to_ms(&e["start"]),
                end: to_ms(&e["end"]),
                place: s(&e, "location"),
                tags: if e["allDay"].as_bool() == Some(true) { format!("{label}, journée entière") } else { label.clone() },
                ..Default::default()
            });
        }
    }
    // Évènements saisis dans l'Agenda de Lumen (clé « events » si présente).
    for e in arr(st.get("events").unwrap_or(&Value::Null)) {
        out.push(Rec {
            id: format!("agenda:{}", s(&e, "id")),
            app: "agenda".into(),
            kind: "event".into(),
            title: s(&e, "title"),
            text: clip(&s(&e, "description"), 400),
            start: to_ms(&e["start"]),
            end: to_ms(&e["end"]),
            place: s(&e, "location"),
            ..Default::default()
        });
    }
    out
}

/// Lecteur générique d'un état d'app : tout objet titré devient une fiche.
fn generic_state(name: &str, p: &Path) -> Vec<Rec> {
    let st = read_state(p);
    let mut out = vec![];
    fn walk(v: &Value, path: &str, depth: usize, name: &str, out: &mut Vec<Rec>) {
        if depth > 6 || out.len() >= 400 {
            return;
        }
        match v {
            Value::Array(a) => a.iter().for_each(|x| walk(x, path, depth + 1, name, out)),
            Value::Object(m) => {
                let title = ["title", "name", "label", "subject", "question", "front"].iter().map(|k| s(v, k)).find(|x| !x.is_empty()).unwrap_or_default();
                let body = ["text", "body", "content", "description", "desc", "note", "answer", "back", "summary"].iter().map(|k| s(v, k)).find(|x| !x.is_empty()).unwrap_or_default();
                if !title.is_empty() || body.chars().count() > 20 {
                    let id = if s(v, "id").is_empty() { format!("{path}-{}", out.len()) } else { s(v, "id") };
                    out.push(Rec {
                        id: format!("{name}:{id}"),
                        app: name.into(),
                        kind: "item".into(),
                        title: if title.is_empty() { clip(&body, 60) } else { clip(&title, 160) },
                        text: clip(&body, 800),
                        start: ["due", "start", "when", "date"].iter().map(|k| to_ms(&v[*k])).find(|x| *x > 0).unwrap_or(0),
                        updated: ["ts", "updated", "created"].iter().map(|k| to_ms(&v[*k])).find(|x| *x > 0).unwrap_or(0),
                        tags: path.into(),
                        ..Default::default()
                    });
                }
                for (k, x) in m {
                    if x.is_object() || x.is_array() {
                        walk(x, k, depth + 1, name, out);
                    }
                }
            }
            _ => {}
        }
    }
    for (k, v) in &st {
        walk(v, k, 0, name, &mut out);
    }
    // Ids uniques (un même objet peut apparaître deux fois).
    let mut seen = std::collections::HashSet::new();
    out.retain(|r| seen.insert(r.id.clone()));
    out
}

fn tables(p: &Path) -> Vec<Rec> {
    let Ok(c) = Connection::open_with_flags(p, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return vec![] };
    let q = "SELECT t.table_id, t.name, b.name, (SELECT group_concat(name, ', ') FROM columns WHERE table_id = t.table_id ORDER BY ordinal) FROM tables t LEFT JOIN bases b ON b.base_id = t.base_id";
    let Ok(mut st) = c.prepare(q) else { return vec![] };
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?)));
    let mut out = vec![];
    if let Ok(rows) = rows {
        for (id, name, base, cols) in rows.flatten() {
            let n: i64 = c.query_row(&format!("SELECT count(*) FROM \"t_{}\"", id.replace('"', "")), [], |r| r.get(0)).unwrap_or(0);
            out.push(Rec {
                id: format!("bases:{id}"),
                app: "bases".into(),
                kind: "table".into(),
                title: name,
                text: format!("{n} lignes · colonnes : {}", cols.unwrap_or_default()),
                tags: base.clone().unwrap_or_default(),
                rref: base.unwrap_or_default(),
                ..Default::default()
            });
        }
    }
    out
}

fn corpus(p: &Path) -> Vec<Rec> {
    let Ok(c) = Connection::open_with_flags(p, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return vec![] };
    let text_of = |id: &str| -> String {
        let mut out = String::new();
        if let Ok(mut st) = c.prepare("SELECT text FROM chunks WHERE doc_id = ?1 ORDER BY ordinal") {
            if let Ok(rows) = st.query_map([id], |r| r.get::<_, String>(0)) {
                for t in rows.flatten() {
                    out.push_str(&t);
                    out.push('\n');
                    if out.len() > TEXT_CAP {
                        break;
                    }
                }
            }
        }
        cap(&out)
    };
    let Ok(mut st) = c.prepare("SELECT doc_id, title, source, created_at FROM docs") else { return vec![] };
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<i64>>(3)?)));
    rows.map(|rows| {
        rows.flatten()
            .map(|(id, title, source, created)| Rec {
                // (texte intégral du document, découpé par le Corpus)
                id: format!("corpus:{id}"),
                app: "corpus".into(),
                kind: "document".into(),
                title,
                text: text_of(&id),
                tags: source.filter(|x| x.starts_with("project:")).map(|_| "projet de l'assistant".to_string()).unwrap_or_default(),
                updated: created.unwrap_or(0),
                ..Default::default()
            })
            .collect()
    })
    .unwrap_or_default()
}

/// Extensions lues comme du texte brut.
const TEXT_EXTS: &[&str] = &[
    "md", "markdown", "txt", "text", "csv", "tsv", "json", "yaml", "yml", "toml", "ini", "log", "xml",
    "py", "js", "mjs", "ts", "tsx", "jsx", "rs", "swift", "kt", "java", "c", "h", "cpp", "hpp", "cs", "go", "rb", "php",
    "sh", "zsh", "bash", "sql", "css", "scss", "lua", "r", "tex", "srt", "vtt", "ics", "vcf",
];
/// Documents de Lumen (JSON) : Opus (pages), présentations, classeurs Calc.
const LUMEN_DOC_EXTS: &[&str] = &["lumenpages", "lumenkey", "lumensheet", "lumendoc", "lumenslides"];
const MEDIA_EXTS: &[&str] = &["mp3", "m4a", "aac", "wav", "ogg", "flac", "mp4", "m4v", "mov", "webm", "mkv", "avi"];
/// Sans intérêt pour l'IA (polices, caches, modèles entraînés…).
const SKIP_EXTS: &[&str] = &["woff", "woff2", "ttf", "otf", "eot", "joblib", "pyc", "ds_store", "tmp", "lock"];
const MAX_EXTRACT_BYTES: u64 = 32 * 1024 * 1024;

/// Texte lisible d'un document JSON de Lumen : titres, textes (HTML nettoyé),
/// cellules — jamais les images en base64 ni la géométrie.
pub fn lumen_doc_text(v: &Value) -> String {
    fn strip_html(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut tag = false;
        for c in s.chars() {
            match c {
                '<' => tag = true,
                '>' => {
                    tag = false;
                    out.push(' ');
                }
                _ if !tag => out.push(c),
                _ => {}
            }
        }
        out.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
    }
    fn walk(v: &Value, key: &str, out: &mut Vec<String>, depth: usize) {
        if depth > 12 || out.len() > 20_000 {
            return;
        }
        match v {
            Value::String(x) => {
                let x = x.trim();
                let wanted = matches!(key, "title" | "text" | "html" | "content" | "notes" | "name" | "label" | "caption" | "value" | "body" | "speakerNotes" | "cell")
                    || key.len() <= 4 && key.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && key.chars().skip(1).all(|c| c.is_ascii_digit());
                if wanted && !x.is_empty() && !x.starts_with("data:") && !x.starts_with('#') && x.len() < 50_000 {
                    let t = if x.contains('<') { strip_html(x) } else { x.to_string() };
                    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
                    if !t.is_empty() {
                        out.push(t);
                    }
                }
            }
            Value::Number(n) if key.len() <= 4 && key.chars().next().is_some_and(|c| c.is_ascii_uppercase()) => out.push(n.to_string()),
            Value::Array(a) => a.iter().for_each(|x| walk(x, key, out, depth + 1)),
            // Classeur : cellules « A1 » remises en lignes « a | b | c ».
            Value::Object(m) if key == "cells" => {
                let mut rows: BTreeMap<u32, Vec<(String, String)>> = BTreeMap::new();
                for (addr, v) in m {
                    let col: String = addr.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
                    let Ok(row) = addr[col.len()..].parse::<u32>() else { continue };
                    let val = match v {
                        Value::String(x) => x.clone(),
                        Value::Object(o) => o.get("v").or(o.get("value")).map(readable).unwrap_or_default(),
                        other => readable(other),
                    };
                    if !val.is_empty() {
                        rows.entry(row).or_default().push((format!("{:>3}", col), val));
                    }
                }
                for (_, mut cells) in rows {
                    cells.sort();
                    out.push(cells.into_iter().map(|x| x.1).collect::<Vec<_>>().join(" | "));
                }
            }
            Value::Object(m) => m.iter().for_each(|(k, x)| walk(x, k, out, depth + 1)),
            _ => {}
        }
    }
    let mut out = vec![];
    walk(v, "", &mut out, 0);
    let mut seen = std::collections::HashSet::new();
    out.retain(|x| seen.insert(x.clone()));
    out.join("\n")
}

/// Texte d'un fichier (None = pas un format texte). Les extractions coûteuses
/// passent par le cache `filecache` (clé = chemin, signature = taille + date).
fn file_text(app: &tauri::AppHandle, path: &Path, ext: &str, size: u64, mtime: i64) -> Option<String> {
    let is_text = TEXT_EXTS.contains(&ext);
    let is_lumen = LUMEN_DOC_EXTS.contains(&ext);
    let is_rich = crate::rag::RICH_DOC_EXTS.contains(&ext);
    if !(is_text || is_lumen || is_rich) || size > MAX_EXTRACT_BYTES {
        return None;
    }
    if is_text {
        let bytes = std::fs::read(path).ok()?;
        let head = &bytes[..bytes.len().min(TEXT_CAP * 2)];
        return Some(cap(&String::from_utf8_lossy(head)));
    }
    let key = path.to_string_lossy().to_string();
    let sig = format!("{size}:{mtime}");
    if let Ok(Some(t)) = with_db(app, |c| {
        c.query_row("SELECT text FROM filecache WHERE path = ?1 AND sig = ?2", params![key, sig], |r| r.get::<_, String>(0)).map(Some).or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(e),
        })
    }) {
        return Some(t);
    }
    let bytes = std::fs::read(path).ok()?;
    let text = if is_lumen {
        serde_json::from_slice::<Value>(&bytes).map(|v| lumen_doc_text(&v)).unwrap_or_default()
    } else {
        let name = path.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
        crate::rag::extract_document_text(&name, &bytes).unwrap_or_default()
    };
    let text = cap(&text);
    let _ = with_db(app, |c| c.execute("INSERT OR REPLACE INTO filecache (path, sig, text) VALUES (?1, ?2, ?3)", params![key, sig, text]));
    Some(text)
}

/// Dossiers ignorés : journaux d'exécution des agents, caches, dépendances.
/// Du bruit pour la recherche (« la note n'a pas été trouvée »…) et du
/// stockage pour rien.
const SKIP_DIRS: &[&str] = &["journal", "node_modules", "__pycache__", ".git", "cache", ".cache", "tmp", "thumbnails", "snapshots"];
/// Dossiers d'ÉTAT d'apps (canevas, aventures, flux, analyses, cartes
/// mentales, modèles ML, mini-apps exportées) : leurs JSON/HTML sont des
/// sauvegardes internes, pas des documents. Fichiers listés (lien), texte non indexé.
const APP_STATE_DIRS: &[&str] = &["canevas", "adventures", "flux", "analysis", "mindmaps", "ml", "apps", "reporting", "creative", "moodboard"];
/// Formats « source » d'un document : un export du même nom (HTML, PDF) à côté
/// est un doublon — listé avec son lien, mais son texte n'est pas réindexé.
const SOURCE_DOC_EXTS: &[&str] = &["lumenpages", "lumenkey", "lumensheet", "lumendoc", "md", "docx", "pptx", "xlsx", "odt"];

fn sandbox_files(app: &tauri::AppHandle, sb_id: &str, sb_name: &str, root: &Path) -> Vec<Rec> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let entries: Vec<_> = rd.flatten().collect();
        // Noms (sans extension) des documents sources de ce dossier.
        let sources: std::collections::HashSet<String> = entries
            .iter()
            .filter_map(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                let (stem, ext) = n.rsplit_once('.')?;
                SOURCE_DOC_EXTS.contains(&ext.to_ascii_lowercase().as_str()).then(|| stem.to_lowercase())
            })
            .collect();
        let rel_dir = dir.strip_prefix(root).map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        let in_app_state = rel_dir.split(['/', '\\']).any(|c| APP_STATE_DIRS.contains(&c));
        for e in entries {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.to_lowercase().as_str()) {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                stack.push(p);
                continue;
            }
            let ext = crate::rag::ext_of(&name);
            if SKIP_EXTS.contains(&ext.as_str()) {
                continue;
            }
            let rel = p.strip_prefix(root).map(|x| x.to_string_lossy().replace('\\', "/")).unwrap_or(name.clone());
            let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
            let stem = name.rsplit_once('.').map(|x| x.0.to_lowercase()).unwrap_or_default();
            let duplicate = matches!(ext.as_str(), "html" | "htm" | "pdf") && sources.contains(&stem);
            let state_file = in_app_state && matches!(ext.as_str(), "json" | "html" | "htm" | "js" | "css");
            let big_json = ext == "json" && md.len() > 256 * 1024;
            let text = if duplicate || state_file || big_json { None } else { file_text(app, &p, &ext, md.len(), mtime) };
            let kind = if text.is_some() {
                "document"
            } else if crate::rag::IMAGE_EXTS.contains(&ext.as_str()) || ext == "heic" || ext == "svg" {
                "image"
            } else if MEDIA_EXTS.contains(&ext.as_str()) {
                "media"
            } else {
                "file"
            };
            let size = if md.len() >= 1024 * 1024 { format!("{:.1} Mo", md.len() as f64 / 1_048_576.0) } else { format!("{} Ko", md.len().div_ceil(1024)) };
            out.push(Rec {
                id: format!("fichiers:{sb_id}:{rel}"),
                app: "fichiers".into(),
                kind: kind.into(),
                title: name,
                text: text.unwrap_or_else(|| {
                    if duplicate {
                        format!("export {} d'un document de la sandbox « {sb_name} » (texte indexé dans le document source)", ext.to_uppercase())
                    } else {
                        format!("fichier {} de {size} dans la sandbox « {sb_name} »", ext.to_uppercase())
                    }
                }),
                tags: [sb_name.to_string(), rel.rsplit_once('/').map(|x| x.0.to_string()).unwrap_or_default(), ext.clone()].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(", "),
                rref: format!("{sb_id}:{rel}"),
                url: media_url(sb_id, &rel),
                status: size,
                updated: mtime,
                ..Default::default()
            });
            if out.len() >= 5000 {
                return out;
            }
        }
    }
    out
}

// ----- Coffre clé → valeur (iPhone, Raccourcis, agents) -----

/// Libellés humains des clés connues du coffre.
fn vault_label(key: &str) -> Option<(&'static str, &'static str, &'static str)> {
    // (libellé, unité, type)
    Some(match key {
        "sante/pas" => ("Pas aujourd'hui", "pas", "metric"),
        "sante/sommeil_h" => ("Sommeil de la dernière nuit", "h", "metric"),
        "sante/fc_repos" => ("Fréquence cardiaque au repos", "bpm", "metric"),
        "sante/calories_actives" => ("Calories actives aujourd'hui", "kcal", "metric"),
        "sante/maj" => ("Dernière synchro santé de l'iPhone", "", "value"),
        "lieu/actuel" => ("Lieu actuel", "", "value"),
        "courses" => ("Liste de courses", "", "list"),
        _ => return None,
    })
}

fn vault_recs(entries: &[crate::vault::Entry]) -> Vec<Rec> {
    let mut out = vec![];
    for e in entries {
        let dev = e.device.clone();
        match e.key.as_str() {
            // Agenda et rappels de l'iPhone : une fiche par élément.
            "agenda/iphone" => {
                for (i, ev) in arr(&e.value).iter().enumerate() {
                    out.push(Rec {
                        id: format!("coffre:agenda/iphone:{i}:{}", s(ev, "debut")),
                        app: "iphone".into(),
                        kind: "event".into(),
                        title: s(ev, "titre"),
                        start: parse_date(&s(ev, "debut")),
                        end: parse_date(&s(ev, "fin")),
                        place: s(ev, "lieu"),
                        tags: [s(ev, "agenda"), if ev["journee"].as_bool() == Some(true) { "journée entière".into() } else { String::new() }].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(", "),
                        text: "agenda de l'iPhone".into(),
                        rref: e.key.clone(),
                        updated: e.updated_ms as i64,
                        ..Default::default()
                    });
                }
            }
            "rappels/iphone" => {
                for (i, r) in arr(&e.value).iter().enumerate() {
                    out.push(Rec {
                        id: format!("coffre:rappels/iphone:{i}"),
                        app: "iphone".into(),
                        kind: "task".into(),
                        title: s(r, "titre"),
                        start: parse_date(&s(r, "echeance")),
                        status: "à faire".into(),
                        tags: s(r, "liste"),
                        text: "rappel de l'iPhone".into(),
                        rref: e.key.clone(),
                        updated: e.updated_ms as i64,
                        ..Default::default()
                    });
                }
            }
            "iphone/partages" => {
                for (i, f) in arr(&e.value).iter().enumerate() {
                    out.push(Rec {
                        id: format!("coffre:iphone/partages:{i}"),
                        app: "iphone".into(),
                        kind: "file".into(),
                        title: s(f, "name"),
                        text: format!("partagé depuis l'iPhone ({})", s(f, "kind")),
                        rref: format!("{}:{}", s(f, "sandbox"), s(f, "path")),
                        url: String::new(),
                        updated: e.updated_ms as i64,
                        ..Default::default()
                    });
                }
            }
            key => {
                let (label, unit, kind) = vault_label(key).unwrap_or_else(|| {
                    let k = match e.kind.as_str() {
                        "number" => "metric",
                        "list" => "list",
                        _ => "value",
                    };
                    ("", "", k)
                });
                let value = match &e.value {
                    Value::Array(a) => a.iter().map(readable).collect::<Vec<_>>().join(" ; "),
                    v => readable(v),
                };
                let value = if unit.is_empty() { value } else { format!("{value} {unit}") };
                let value = if e.kind == "date" { fmt_date(parse_date(&value), false) } else { value };
                let history = if kind != "metric" { vec![] } else { e.history.iter().rev().take(5).map(|h| format!("{} ({})", readable(&h.value), fmt_date(h.updated_ms as i64, false))).collect::<Vec<_>>() };
                out.push(Rec {
                    id: format!("coffre:{key}"),
                    app: if key.starts_with("sante/") || dev == "iPhone" { "iphone".into() } else { "coffre".into() },
                    kind: kind.into(),
                    title: if label.is_empty() { key.to_string() } else { label.to_string() },
                    text: if history.is_empty() { value } else { format!("{value} · avant : {}", history.join(", ")) },
                    status: if dev.is_empty() { String::new() } else { format!("écrit par {dev}") },
                    tags: key.split('/').next().unwrap_or("").to_string(),
                    rref: key.to_string(),
                    updated: e.updated_ms as i64,
                    ..Default::default()
                });
            }
        }
    }
    out
}

/// Valeur JSON lisible (objets « clé : valeur », pas de JSON brut).
pub fn readable(v: &Value) -> String {
    match v {
        Value::String(x) => x.clone(),
        Value::Null => "—".into(),
        Value::Array(a) => a.iter().map(readable).collect::<Vec<_>>().join(", "),
        Value::Object(m) => m.iter().filter(|(_, x)| !matches!(x, Value::Null) && x.as_str() != Some("")).map(|(k, x)| format!("{k} : {}", readable(x))).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    }
}

/// Tous les connecteurs pour le profil actif.
fn sources(app: &tauri::AppHandle) -> Vec<Source> {
    let Some(dir) = data_dir(app) else { return vec![] };
    let set = settings(app);
    let mut v: Vec<Source> = vec![];
    macro_rules! file_src {
        ($id:expr, $fr:expr, $en:expr, $file:expr, $f:expr) => {{
            let p = dir.join($file);
            let p2 = p.clone();
            v.push(Source { id: $id.into(), label_fr: $fr.into(), label_en: $en.into(), scope: "*".into(), files: vec![p], read: Box::new(move |_| $f(&p2)) });
        }};
    }
    file_src!("kanban", "Kanban", "Kanban", "kanban.json", kanban);
    file_src!("rappels", "Rappels", "Reminders", "reminders.json", reminders);
    file_src!("agenda", "Agenda", "Calendar", "app-state/calendar.json", calendar);
    file_src!("notes", "Notes", "Notes", "app-state/notes.json", notes);
    file_src!("contacts", "Contacts", "Contacts", "contacts.json", contacts);
    file_src!("messagerie", "Messagerie des agents", "Agent inbox", "inbox.json", inbox);
    file_src!("courrier", "Courrier", "Mail", "mail.json", mail);
    file_src!("agents", "Agents", "Agents", "agents.json", agents);
    file_src!("bases", "Bases de données", "Databases", "tables.db", tables);
    file_src!("corpus", "Documents (Corpus)", "Documents (Corpus)", "rag.db", corpus);

    // Coffre clé → valeur du profil actif.
    let profile = crate::session::active_profile_id(app);
    let safe: String = profile.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
    let vf = dir.join("vault").join(format!("{}.json", if safe.is_empty() { "default" } else { &safe }));
    let pr = profile.clone();
    v.push(Source {
        id: "coffre".into(),
        label_fr: "Coffre (iPhone, Raccourcis, agents)".into(),
        label_en: "Vault (iPhone, Shortcuts, agents)".into(),
        scope: profile.clone(),
        files: vec![vf],
        read: Box::new(move |app| {
            let mut all = crate::vault::ai_list(app, &pr, "");
            // L'historique est utile pour les mesures (évolution).
            for e in all.iter_mut() {
                if let Some(full) = crate::vault::get(app, &pr, &e.key) {
                    e.history = full.history;
                }
            }
            vault_recs(&all)
        }),
    });

    // Autres états d'app (lecteur générique).
    const SKIP: &[&str] = &["notes", "calendar", "ai-access-log", "pdf", "scheduler", "robotstudio", "media"];
    if let Ok(rd) = std::fs::read_dir(dir.join("app-state")) {
        for e in rd.flatten() {
            let p = e.path();
            let Some(name) = p.file_stem().map(|x| x.to_string_lossy().to_string()) else { continue };
            if p.extension().and_then(|x| x.to_str()) != Some("json") || name.starts_with('.') || SKIP.contains(&name.as_str()) {
                continue;
            }
            let label = match name.as_str() {
                "studies" => "Études",
                "moodboard" => "Moodboard",
                "podcast" => "Podcast",
                "carte" => "Carte",
                "photos" => "Photos",
                _ => "",
            };
            let label = if label.is_empty() { name.clone() } else { label.to_string() };
            let (n2, p2) = (name.clone(), p.clone());
            v.push(Source { id: name.clone(), label_fr: label.clone(), label_en: label, scope: "*".into(), files: vec![p], read: Box::new(move |_| generic_state(&n2, &p2)) });
        }
    }

    // Fichiers des sandboxes partagées avec le coffre.
    let registry = arr(&read_json(&dir.join("sandboxes").join("registry.json")));
    for sb in registry {
        let id = s(&sb, "id");
        if set.excluded_sandboxes.contains(&id) {
            continue;
        }
        let name = s(&sb, "name");
        let root = dir.join("sandboxes").join(&id).join("root");
        let (i2, n2, r2) = (id.clone(), name.clone(), root.clone());
        v.push(Source {
            id: format!("fichiers:{id}"),
            label_fr: format!("Fichiers · {name}"),
            label_en: format!("Files · {name}"),
            scope: "*".into(),
            files: vec![root],
            read: Box::new(move |app| sandbox_files(app, &i2, &n2, &r2)),
        });
    }
    v.retain(|x| !set.disabled.contains(&x.id));
    v
}

/// Signature d'une source : taille + date de modification de ses fichiers
/// (pour un dossier : nombre d'entrées et modification la plus récente).
fn signature(files: &[PathBuf]) -> String {
    let mut out = String::new();
    for f in files {
        let Ok(md) = std::fs::metadata(f) else {
            out.push_str("-;");
            continue;
        };
        if md.is_dir() {
            let (mut n, mut last) = (0u64, 0u128);
            let mut stack = vec![f.clone()];
            while let Some(d) = stack.pop() {
                if let Ok(rd) = std::fs::read_dir(&d) {
                    for e in rd.flatten() {
                        n += 1;
                        if let Ok(m) = e.metadata() {
                            last = last.max(m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0));
                            if m.is_dir() && n < 20_000 {
                                stack.push(e.path());
                            }
                        }
                    }
                }
            }
            out.push_str(&format!("d{n}:{last};"));
        } else {
            let t = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
            out.push_str(&format!("{}:{t};", md.len()));
        }
    }
    out
}

// ===================== Index SQLite =====================

static DB: Mutex<Option<(PathBuf, Connection)>> = Mutex::new(None);
static SIGS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn with_db<T>(app: &tauri::AppHandle, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
    let dir = data_dir(app).ok_or("dossier de données introuvable")?.join("vault");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("hub.db");
    let mut g = DB.lock().map_err(|_| "index occupé")?;
    if g.as_ref().map(|(p, _)| p != &path).unwrap_or(true) {
        let c = Connection::open(&path).map_err(|e| e.to_string())?;
        // v2 : colonne `url` + cache d'extraction. L'index se reconstruit seul.
        let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
        if version < 2 {
            c.execute_batch("DROP TABLE IF EXISTS recs; DROP TABLE IF EXISTS sources; PRAGMA user_version = 2;").map_err(|e| e.to_string())?;
            if let Ok(mut g) = SIGS.lock() {
                *g = None;
            }
        }
        c.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE VIRTUAL TABLE IF NOT EXISTS recs USING fts5(
               id UNINDEXED, app UNINDEXED, type UNINDEXED, scope UNINDEXED,
               title, text, tags, people, place,
               start UNINDEXED, end UNINDEXED, status UNINDEXED, ref UNINDEXED, updated UNINDEXED, url UNINDEXED,
               tokenize = 'unicode61 remove_diacritics 2');
             CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, scope TEXT, label_fr TEXT, label_en TEXT, count INTEGER, indexed INTEGER);
             CREATE TABLE IF NOT EXISTS filecache (path TEXT PRIMARY KEY, sig TEXT, text TEXT);
             CREATE TABLE IF NOT EXISTS vecs (rec_id TEXT NOT NULL, ord INTEGER NOT NULL, model TEXT NOT NULL, sig TEXT NOT NULL, text TEXT NOT NULL, v BLOB NOT NULL, PRIMARY KEY (rec_id, ord));",
        )
        .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        *g = Some((path, c));
    }
    f(&g.as_ref().unwrap().1).map_err(|e| e.to_string())
}

fn store(app: &tauri::AppHandle, src: &Source, recs: &[Rec]) -> Result<(), String> {
    with_db(app, |c| {
        let tx = c.unchecked_transaction()?;
        tx.execute("DELETE FROM recs WHERE scope = ?2 AND id LIKE ?1 || ':%'", params![src.id, src.scope])?;
        {
            let mut ins = tx.prepare("INSERT INTO recs (id, app, type, scope, title, text, tags, people, place, start, end, status, ref, updated, url) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)")?;
            for r in recs {
                ins.execute(params![r.id, r.app, r.kind, src.scope, r.title, r.text, r.tags, r.people, r.place, r.start, r.end, r.status, r.rref, r.updated, r.url])?;
            }
        }
        tx.execute(
            "INSERT OR REPLACE INTO sources (id, scope, label_fr, label_en, count, indexed) VALUES (?1,?2,?3,?4,?5,?6)",
            params![src.id, src.scope, src.label_fr, src.label_en, recs.len() as i64, now_ms()],
        )?;
        tx.commit()
    })
}

/// Réindexe les sources dont la signature a changé (toutes si `force`).
pub fn refresh(app: &tauri::AppHandle, force: bool) -> usize {
    let srcs = sources(app);
    let mut done = 0;
    let mut sigs = SIGS.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
    for src in &srcs {
        let key = format!("{}|{}", src.scope, src.id);
        let sig = signature(&src.files);
        if !force && sigs.get(&key) == Some(&sig) {
            continue;
        }
        let recs: Vec<Rec> = (src.read)(app).into_iter().filter(|r| !r.title.trim().is_empty()).collect();
        if store(app, src, &recs).is_ok() {
            sigs.insert(key, sig);
            done += 1;
        }
    }
    // Sources disparues ou coupées : on retire leurs fiches.
    let live: std::collections::HashSet<String> = srcs.iter().map(|x| x.id.clone()).collect();
    let _ = with_db(app, |c| {
        let ids: Vec<String> = c.prepare("SELECT id FROM sources")?.query_map([], |r| r.get(0))?.flatten().collect();
        for id in ids.into_iter().filter(|x| !live.contains(x)) {
            c.execute("DELETE FROM recs WHERE id LIKE ?1 || ':%'", params![id])?;
            c.execute("DELETE FROM sources WHERE id = ?1", params![id])?;
            done += 1;
        }
        Ok(())
    });
    if let Ok(mut g) = SIGS.lock() {
        *g = Some(sigs);
    }
    if done > 0 {
        let _ = app.emit("datahub-changed", done);
    }
    done
}

/// Demande un réindexage rapide (coffre modifié, état d'app enregistré).
pub fn touch(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(800));
        refresh(&app, false);
    });
}

/// Balayage de fond : premier index complet, puis toutes les 15 s.
pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        refresh(&app, true);
        embed_pending(&app);
        loop {
            std::thread::sleep(Duration::from_secs(15));
            refresh(&app, false);
            embed_pending(&app);
        }
    });
}

// ===================== Recherche par le sens (vecteurs) =====================
//
// Chaque fiche porteuse de texte est découpée en passages (~800 caractères,
// chevauchement 120) encodés par l'encodeur LOCAL du Corpus. Les vecteurs
// vivent dans `vecs`, à côté des fiches ; ils ne sont recalculés que si le
// texte change (signature) ou si l'encodeur change. Sans encodeur local, rien
// n'est encodé et la recherche reste en plein texte.

/// Types dont le texte a un sens à encoder.
const EMBED_TYPES: &[&str] = &["document", "note", "message", "event", "task", "contact", "table", "item", "list"];
const CHUNK: usize = 800;
const OVERLAP: usize = 120;
const MAX_CHUNKS_PER_REC: usize = 30;
/// Passages encodés par balayage (le reste au suivant) : Lumen reste réactif.
const EMBED_BUDGET: usize = 300;

fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Passages d'une fiche : titre en tête de chacun (contexte), texte découpé.
pub fn chunks(title: &str, text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return vec![title.to_string()];
    }
    let mut out = vec![];
    let mut i = 0;
    while i < chars.len() && out.len() < MAX_CHUNKS_PER_REC {
        let mut end = (i + CHUNK).min(chars.len());
        // Coupe sur une fin de phrase ou un espace si possible.
        if end < chars.len() {
            if let Some(k) = (i + CHUNK / 2..end).rev().find(|&k| matches!(chars[k], '.' | '\n' | '!' | '?')) {
                end = k + 1;
            } else if let Some(k) = (i + CHUNK / 2..end).rev().find(|&k| chars[k] == ' ') {
                end = k;
            }
        }
        let body: String = chars[i..end].iter().collect();
        out.push(format!("{title}\n{}", body.trim()));
        if end >= chars.len() {
            break;
        }
        i = end.saturating_sub(OVERLAP).max(i + 1);
    }
    out
}

fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}
fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// Encode les fiches nouvelles ou modifiées (budget limité par passage).
pub fn embed_pending(app: &tauri::AppHandle) -> usize {
    let Some(emb) = crate::rag::hub_embedder(app) else { return 0 };
    let model = emb.model().to_string();
    // Fiches à (ré)encoder : signature absente, différente, ou autre modèle.
    let types = EMBED_TYPES.iter().map(|t| format!("'{t}'")).collect::<Vec<_>>().join(",");
    let todo: Vec<(String, String, String)> = with_db(app, |c| {
        // Vecteurs orphelins (fiche disparue) ou d'un autre encodeur.
        c.execute("DELETE FROM vecs WHERE model != ?1 OR rec_id NOT IN (SELECT id FROM recs)", params![model])?;
        let mut st = c.prepare(&format!("SELECT id, title, text FROM recs WHERE type IN ({types})"))?;
        let rows: Vec<(String, String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.flatten().collect();
        let mut have: HashMap<String, String> = HashMap::new();
        let mut st2 = c.prepare("SELECT rec_id, sig FROM vecs WHERE ord = 0")?;
        for (id, sig) in st2.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.flatten() {
            have.insert(id, sig);
        }
        Ok(rows.into_iter().filter(|(id, t, x)| have.get(id) != Some(&fnv(&format!("{t}\n{x}")))).collect())
    })
    .unwrap_or_default();
    let mut done = 0;
    for (id, title, text) in todo {
        if done >= EMBED_BUDGET {
            break;
        }
        let sig = fnv(&format!("{title}\n{text}"));
        let parts = chunks(&title, &text);
        let mut vecs = vec![];
        for p in &parts {
            match emb.embed(p, false) {
                Ok(v) => vecs.push(v),
                Err(_) => return done, // encodeur tombé : on reprendra au prochain passage
            }
        }
        done += parts.len();
        let _ = with_db(app, |c| {
            let tx = c.unchecked_transaction()?;
            tx.execute("DELETE FROM vecs WHERE rec_id = ?1", params![id])?;
            for (i, (p, v)) in parts.iter().zip(vecs.iter()).enumerate() {
                tx.execute("INSERT INTO vecs (rec_id, ord, model, sig, text, v) VALUES (?1,?2,?3,?4,?5,?6)", params![id, i as i64, model, sig, p, to_blob(v)])?;
            }
            tx.commit()
        });
    }
    if done > 0 {
        if let Ok(mut g) = VEC_CACHE.lock() {
            *g = None;
        }
    }
    done
}

/// Vecteurs en mémoire (rechargés quand ils changent) : quelques milliers de
/// passages, une recherche exhaustive prend quelques millisecondes.
struct VecCache {
    model: String,
    rows: Vec<(String, String, Vec<f32>)>, // (fiche, passage, vecteur)
}
static VEC_CACHE: Mutex<Option<VecCache>> = Mutex::new(None);

/// Passages les plus proches du sens de la question : (fiche, passage, similarité).
fn semantic(app: &tauri::AppHandle, text: &str, k: usize) -> Vec<(String, String, f64)> {
    let has_vecs = with_db(app, |c| c.query_row("SELECT count(*) FROM vecs", [], |r| r.get::<_, i64>(0))).unwrap_or(0) > 0;
    if !has_vecs || text.trim().chars().count() < 3 {
        return vec![];
    }
    let Some(emb) = crate::rag::hub_embedder(app) else { return vec![] };
    let Ok(qv) = emb.embed(text, true) else { return vec![] };
    let model = emb.model().to_string();
    let mut g = match VEC_CACHE.lock() {
        Ok(g) => g,
        Err(_) => return vec![],
    };
    if g.as_ref().map(|c| c.model != model).unwrap_or(true) {
        let rows = with_db(app, |c| {
            let mut st = c.prepare("SELECT rec_id, text, v FROM vecs WHERE model = ?1")?;
            let r: Vec<(String, String, Vec<f32>)> = st.query_map(params![model], |r| Ok((r.get(0)?, r.get(1)?, from_blob(&r.get::<_, Vec<u8>>(2)?))))?.flatten().collect();
            Ok(r)
        })
        .unwrap_or_default();
        *g = Some(VecCache { model, rows });
    }
    let cache = g.as_ref().unwrap();
    // Meilleur passage par fiche.
    let mut best: HashMap<&str, (f64, &str)> = HashMap::new();
    for (id, t, v) in &cache.rows {
        let sim = crate::rag::cosine(&qv, v);
        let e = best.entry(id.as_str()).or_insert((f64::MIN, t.as_str()));
        if sim > e.0 {
            *e = (sim, t.as_str());
        }
    }
    let mut v: Vec<(String, String, f64)> = best.into_iter().map(|(id, (s, t))| (id.to_string(), t.to_string(), s)).collect();
    v.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    // Seuil RELATIF (l'échelle dépend de l'encodeur) : proches du meilleur.
    let top = v.first().map(|x| x.2).unwrap_or(0.0);
    v.retain(|x| x.2 >= top - 0.12 && x.2 > 0.2);
    v.truncate(k);
    v
}

// ===================== Requêtes =====================

#[derive(Default, Debug, Clone)]
pub struct Query {
    pub text: String,
    pub types: Vec<String>,
    pub apps: Vec<String>,
    pub from: i64,
    pub to: i64,
    pub status: String,
    pub limit: usize,
    /// Tri : "relevance" | "start" | "recent".
    pub order: String,
    /// Une seule source (id de connecteur : « kanban », « fichiers:<sb> »…).
    pub source: String,
}

/// Requête FTS5 tolérante : mots de 2+ lettres, préfixes (« réunion* »), OU.
fn fts_expr(q: &str) -> String {
    fts_terms(q).join(" OR ")
}

/// Termes FTS5 d'une question (voir fts_expr).
fn fts_terms(q: &str) -> Vec<String> {
    let stop = ["les", "des", "une", "dans", "pour", "avec", "sur", "que", "qui", "est", "mes", "mon", "ma", "the", "and", "for", "my", "du", "de", "la", "le", "un", "et", "à", "au"];
    q.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 2 && !stop.contains(&w.to_lowercase().as_str()))
        .take(8)
        .map(|w| {
            // Pluriel toléré : « pokémons » cherche « pokémon* », « travaux » « travau* ».
            let n = w.chars().count();
            let w = if n > 4 && (w.ends_with('s') || w.ends_with('x')) { &w[..w.len() - 1] } else { w };
            format!("\"{}\"*", w.replace('"', ""))
        })
        .collect::<Vec<_>>()
}

pub fn query(app: &tauri::AppHandle, q: &Query) -> Result<Vec<Rec>, String> {
    query_as(app, &crate::session::active_profile_id(app), q)
}

/// Même requête pour un profil donné (appareil appairé à un profil).
/// Recherche façon moteur : d'abord TOUS les mots (ET), puis au moins un (OU) ;
/// classement BM25 (titre ×10, étiquettes/personnes ×3), extrait surligné.
pub fn query_as(app: &tauri::AppHandle, profile: &str, q: &Query) -> Result<Vec<Rec>, String> {
    // « ma NOTE sur X », « la PHOTO de Y », « le PDF de Z » : le mot désigne le
    // TYPE de fiche, pas son contenu. On essaie d'abord avec ce type et sans le
    // mot ; puis sans filtre si rien ne sort.
    if q.types.is_empty() {
        let (rest, kinds) = split_type_words(&q.text);
        if !kinds.is_empty() && !fts_terms(&rest).is_empty() {
            let typed = Query { text: rest.clone(), types: kinds, ..q.clone() };
            let r = search(app, profile, &typed)?;
            if !r.is_empty() {
                return Ok(r);
            }
            return search(app, profile, &Query { text: rest, ..q.clone() });
        }
    }
    search(app, profile, q)
}

/// Mots d'une question qui désignent un type de fiche → (question sans eux, types).
fn split_type_words(q: &str) -> (String, Vec<String>) {
    const MAP: &[(&[&str], &[&str])] = &[
        (&["note", "notes"], &["note"]),
        (&["photo", "photos", "image", "images", "illustration"], &["image"]),
        (&["pdf", "document", "documents", "doc", "fichier", "fichiers"], &["document", "file"]),
        (&["mail", "mails", "email", "e-mail", "courriel", "courriels", "message", "messages"], &["message"]),
        (&["contact", "contacts", "numéro", "téléphone"], &["contact"]),
        (&["rdv", "rendez-vous", "évènement", "événement", "évènements", "événements", "réunion"], &["event"]),
        (&["tâche", "tâches", "rappel", "rappels", "todo"], &["task"]),
        (&["vidéo", "vidéos", "audio", "musique"], &["media"]),
    ];
    let mut kinds: Vec<String> = vec![];
    let rest: Vec<&str> = q
        .split_whitespace()
        .filter(|w| {
            let lw = w.trim_matches(|c: char| !c.is_alphanumeric() && c != '-').to_lowercase();
            match MAP.iter().find(|(ws, _)| ws.contains(&lw.as_str())) {
                Some((_, ks)) => {
                    kinds.extend(ks.iter().map(|k| k.to_string()));
                    false
                }
                None => true,
            }
        })
        .collect();
    kinds.dedup();
    (rest.join(" "), kinds)
}

/// Recherche HYBRIDE : plein texte (mots exacts, noms, sigles) + sens
/// (reformulations, synonymes), fusionnés par rang réciproque (RRF, k = 60).
/// Une fiche trouvée par les deux passe devant ; une trouvée par le sens seul
/// arrive avec son passage le plus proche comme extrait (« ≈ »).
fn search(app: &tauri::AppHandle, profile: &str, q: &Query) -> Result<Vec<Rec>, String> {
    let lexical = lexical_search(app, profile, q)?;
    if q.text.trim().is_empty() || q.order == "start" {
        return Ok(lexical);
    }
    let sem = semantic(app, &q.text, 20);
    if sem.is_empty() {
        return Ok(lexical);
    }
    let limit = if q.limit == 0 { 30 } else { q.limit.min(200) };
    let mut score: HashMap<String, f64> = HashMap::new();
    for (i, r) in lexical.iter().enumerate() {
        *score.entry(r.id.clone()).or_default() += 1.0 / (60.0 + i as f64);
    }
    for (i, (id, _, _)) in sem.iter().enumerate() {
        *score.entry(id.clone()).or_default() += 1.0 / (60.0 + i as f64);
    }
    let mut by_id: HashMap<String, Rec> = lexical.into_iter().map(|r| (r.id.clone(), r)).collect();
    for (id, passage, _) in &sem {
        if by_id.contains_key(id) {
            continue;
        }
        let Some(mut r) = get_as(app, profile, id) else { continue };
        // Mêmes filtres que la recherche plein texte.
        let ok = (q.types.is_empty() || q.types.iter().any(|t| t == &r.kind))
            && (q.apps.is_empty() || q.apps.iter().any(|a| a == &r.app))
            && (q.source.is_empty() || r.id.starts_with(&format!("{}:", q.source)))
            && (q.from == 0 || r.start >= q.from)
            && (q.to == 0 || (r.start > 0 && r.start < q.to))
            && match q.status.as_str() {
                "open" => !r.status.starts_with("fait"),
                "done" => r.status.starts_with("fait"),
                _ => true,
            };
        if !ok {
            continue;
        }
        let body = passage.split_once('\n').map(|x| x.1).unwrap_or(passage);
        r.hit = format!("≈ {}", clip(body, 300));
        by_id.insert(id.clone(), r);
    }
    let mut out: Vec<Rec> = by_id.into_values().filter(|r| score.contains_key(&r.id)).collect();
    out.sort_by(|a, b| score[&b.id].partial_cmp(&score[&a.id]).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(limit);
    Ok(out)
}

fn lexical_search(app: &tauri::AppHandle, profile: &str, q: &Query) -> Result<Vec<Rec>, String> {
    let terms = fts_terms(&q.text);
    if terms.len() > 1 {
        let all = run_query(app, profile, q, &terms.join(" AND "))?;
        if !all.is_empty() {
            return Ok(all);
        }
    }
    run_query(app, profile, q, &terms.join(" OR "))
}

/// Facettes d'un résultat : « 3 document, 2 note · fichiers 3, notes 2 ».
pub fn facets(recs: &[Rec]) -> String {
    let mut t: BTreeMap<&str, usize> = BTreeMap::new();
    let mut a: BTreeMap<&str, usize> = BTreeMap::new();
    for r in recs {
        *t.entry(r.kind.as_str()).or_default() += 1;
        *a.entry(r.app.as_str()).or_default() += 1;
    }
    let f = |m: BTreeMap<&str, usize>| m.into_iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", ");
    format!("{} · {}", f(t), f(a))
}

fn run_query(app: &tauri::AppHandle, profile: &str, q: &Query, expr: &str) -> Result<Vec<Rec>, String> {
    let profile = profile.to_string();
    let limit = if q.limit == 0 { 30 } else { q.limit.min(200) };
    let expr = expr.to_string();
    let hit = if expr.is_empty() { "''" } else { "snippet(recs, 5, '«', '»', '…', 28)" };
    let mut sql = format!("SELECT id, app, type, title, text, tags, people, place, CAST(start AS INTEGER), CAST(end AS INTEGER), status, ref, CAST(updated AS INTEGER), url, {hit} FROM recs WHERE (scope = '*' OR scope = ?1)");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(profile)];
    if !expr.is_empty() {
        sql.push_str(" AND recs MATCH ?");
        args.push(Box::new(format!("{{title text tags people place}} : ({expr})")));
    }
    let list = |col: &str, vals: &[String], sql: &mut String, args: &mut Vec<Box<dyn rusqlite::ToSql>>| {
        let vals: Vec<&String> = vals.iter().filter(|x| !x.is_empty()).collect();
        if !vals.is_empty() {
            sql.push_str(&format!(" AND {col} IN ({})", vec!["?"; vals.len()].join(",")));
            for v in vals {
                args.push(Box::new(v.to_lowercase()));
            }
        }
    };
    list("type", &q.types, &mut sql, &mut args);
    list("app", &q.apps, &mut sql, &mut args);
    if !q.source.is_empty() {
        sql.push_str(" AND substr(id, 1, ?) = ?");
        let prefix = format!("{}:", q.source);
        args.push(Box::new(prefix.chars().count() as i64));
        args.push(Box::new(prefix));
    }
    if q.from > 0 {
        sql.push_str(" AND CAST(start AS INTEGER) >= ? ");
        args.push(Box::new(q.from));
    }
    if q.to > 0 {
        sql.push_str(" AND CAST(start AS INTEGER) > 0 AND CAST(start AS INTEGER) < ? ");
        args.push(Box::new(q.to));
    }
    match q.status.as_str() {
        "open" => sql.push_str(" AND status NOT LIKE 'fait%'"),
        "done" => sql.push_str(" AND status LIKE 'fait%'"),
        _ => {}
    }
    sql.push_str(match q.order.as_str() {
        "start" => " ORDER BY CAST(start AS INTEGER) = 0, CAST(start AS INTEGER) ASC",
        "recent" => " ORDER BY MAX(CAST(start AS INTEGER), CAST(updated AS INTEGER)) DESC",
        _ if !expr.is_empty() => " ORDER BY bm25(recs, 0,0,0,0, 10.0, 1.0, 3.0, 3.0, 2.0)",
        _ => " ORDER BY MAX(CAST(start AS INTEGER), CAST(updated AS INTEGER)) DESC",
    });
    sql.push_str(&format!(" LIMIT {limit}"));
    with_db(app, |c| {
        let mut st = c.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let rows = st.query_map(refs.as_slice(), |r| {
            Ok(Rec {
                id: r.get(0)?,
                app: r.get(1)?,
                kind: r.get(2)?,
                title: r.get(3)?,
                text: r.get(4)?,
                tags: r.get(5)?,
                people: r.get(6)?,
                place: r.get(7)?,
                start: r.get::<_, Option<i64>>(8)?.unwrap_or(0),
                end: r.get::<_, Option<i64>>(9)?.unwrap_or(0),
                status: r.get(10)?,
                rref: r.get(11)?,
                updated: r.get::<_, Option<i64>>(12)?.unwrap_or(0),
                url: r.get::<_, Option<String>>(13)?.unwrap_or_default(),
                hit: r.get::<_, Option<String>>(14)?.unwrap_or_default(),
            })
        })?;
        Ok(rows.flatten().collect())
    })
}

/// Browsable personal-data catalog; pagination is independent of AI search limits.
fn catalog_rows(c: &Connection, profile: &str, source: &str, query: &str, offset: usize) -> rusqlite::Result<(Vec<Value>,Vec<String>,i64)> {
    let prefix = if source.is_empty() { String::new() } else { format!("{source}:") };
    let needle = query.trim().to_lowercase();

        let mut st = c.prepare("SELECT id,label_fr,count FROM sources WHERE (scope='*' OR scope=?1) AND id != 'coffre' ORDER BY label_fr")?;
        let sources = st.query_map(params![profile], |r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"count":r.get::<_,i64>(2)?})))?.collect::<Result<Vec<_>,_>>()?;
        let filter = "(scope='*' OR scope=?1) AND substr(id,1,7) != 'coffre:' AND (?2='' OR substr(id,1,length(?2))=?2) AND (?3='' OR instr(lower(title || ' ' || text || ' ' || ref),?3)>0)";
        let total: i64 = c.query_row(&format!("SELECT count(*) FROM recs WHERE {filter}"), params![profile,prefix,needle], |r| r.get(0))?;
        let mut st = c.prepare(&format!("SELECT id FROM recs WHERE {filter} ORDER BY CAST(updated AS INTEGER) DESC,id LIMIT 60 OFFSET ?4"))?;
        let ids = st.query_map(params![profile,prefix,needle,offset.min(i64::MAX as usize) as i64], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    Ok((sources,ids,total))
}

pub fn browse_as(app: &tauri::AppHandle, profile: &str, source: &str, query: &str, offset: usize) -> Result<Value, String> {
    let (sources,ids,total)=with_db(app,|c| catalog_rows(c,profile,source,query,offset))?;
    let records: Vec<Rec> = ids.iter().filter_map(|id| get_exact(app,profile,id)).collect();
    Ok(json!({"sources":sources,"records":records,"total":total,"offset":offset}))
}

pub fn get(app: &tauri::AppHandle, id: &str) -> Option<Rec> {
    get_as(app, &crate::session::active_profile_id(app), id)
}

/// Fiche par id, TOLÉRANTE aux ids mal recopiés par un petit modèle :
/// `projets-17…/fmu…/CV.pdf` (préfixe « fichiers: » perdu, « : » devenu « / »),
/// crochets ou guillemets autour, id tronqué… On essaie l'exact, puis les
/// formes normalisées, puis le nom de fichier / la fin de l'id.
pub fn get_as(app: &tauri::AppHandle, profile: &str, id: &str) -> Option<Rec> {
    let raw = id.trim().trim_matches(|c: char| c == '[' || c == ']' || c == '"' || c == '\'' || c == '`').trim();
    let raw = raw.strip_prefix("id ").unwrap_or(raw).trim();
    if let Some(r) = get_exact(app, profile, raw) {
        return Some(r);
    }
    // « sb/chemin » ou « sb:chemin » → « fichiers:sb:chemin ».
    let mut tries = vec![];
    if !raw.starts_with("fichiers:") {
        if let Some((sb, rest)) = raw.split_once(['/', ':']) {
            tries.push(format!("fichiers:{sb}:{rest}"));
        }
        tries.push(format!("fichiers:{raw}"));
    } else if let Some(rest) = raw.strip_prefix("fichiers:") {
        if let Some((sb, path)) = rest.split_once('/') {
            tries.push(format!("fichiers:{sb}:{path}"));
        }
    }
    for t in &tries {
        if let Some(r) = get_exact(app, profile, t) {
            return Some(r);
        }
    }
    // Dernier recours : fin de l'id (nom de fichier ou identifiant), sans les
    // « … » d'une troncature ; une seule fiche doit correspondre au mieux.
    let tail = raw.trim_end_matches('…').trim_end_matches("...").rsplit(['/', ':']).next().unwrap_or("").trim();
    if tail.chars().count() < 4 {
        return None;
    }
    let candidates: Vec<String> = with_db(app, |c| {
        let mut st = c.prepare("SELECT id FROM recs WHERE (scope = '*' OR scope = ?1) AND (instr(id, ?2) > 0 OR title = ?2) LIMIT 50")?;
        let rows = st.query_map(params![profile, tail], |r| r.get::<_, String>(0))?.flatten().collect();
        Ok(rows)
    })
    .ok()?;
    // Le candidat qui reprend le plus de morceaux de l'id donné (sandbox,
    // dossiers) ; à égalité, le plus court.
    let parts: Vec<&str> = raw.split(['/', ':']).filter(|p| p.len() >= 3).collect();
    let best = candidates.into_iter().max_by_key(|c| (parts.iter().filter(|p| c.contains(*p)).count(), std::cmp::Reverse(c.len())))?;
    get_exact(app, profile, &best)
}

pub(crate) fn get_exact(app: &tauri::AppHandle, profile: &str, id: &str) -> Option<Rec> {
    with_db(app, |c| {
        c.query_row(
            "SELECT id, app, type, title, text, tags, people, place, CAST(start AS INTEGER), CAST(end AS INTEGER), status, ref, CAST(updated AS INTEGER), url FROM recs WHERE id = ?1 AND (scope = '*' OR scope = ?2)",
            params![id, profile],
            |r| {
                Ok(Rec {
                    id: r.get(0)?,
                    app: r.get(1)?,
                    kind: r.get(2)?,
                    title: r.get(3)?,
                    text: r.get(4)?,
                    tags: r.get(5)?,
                    people: r.get(6)?,
                    place: r.get(7)?,
                    start: r.get::<_, Option<i64>>(8)?.unwrap_or(0),
                    end: r.get::<_, Option<i64>>(9)?.unwrap_or(0),
                    status: r.get(10)?,
                    rref: r.get(11)?,
                    updated: r.get::<_, Option<i64>>(12)?.unwrap_or(0),
                    url: r.get::<_, Option<String>>(13)?.unwrap_or_default(),
                    hit: String::new(),
                })
            },
        )
    })
    .ok()
}

/// Inventaire : sources, nombre de fiches par type, fraîcheur.
pub fn overview(app: &tauri::AppHandle) -> Value {
    let profile = crate::session::active_profile_id(app);
    with_db(app, |c| {
        let sources: Vec<Value> = c
            .prepare("SELECT id, label_fr, label_en, count, indexed FROM sources WHERE scope = '*' OR scope = ?1 ORDER BY count DESC")?
            .query_map(params![profile], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "label_fr": r.get::<_, String>(1)?, "label_en": r.get::<_, String>(2)?, "count": r.get::<_, i64>(3)?, "indexed": r.get::<_, i64>(4)? })))?
            .flatten()
            .collect();
        let types: Vec<Value> = c
            .prepare("SELECT type, count(*) FROM recs WHERE scope = '*' OR scope = ?1 GROUP BY type ORDER BY 2 DESC")?
            .query_map(params![profile], |r| Ok(json!({ "type": r.get::<_, String>(0)?, "count": r.get::<_, i64>(1)? })))?
            .flatten()
            .collect();
        let vec_recs: i64 = c.query_row("SELECT count(DISTINCT rec_id) FROM vecs", [], |r| r.get(0)).unwrap_or(0);
        let vec_passages: i64 = c.query_row("SELECT count(*) FROM vecs", [], |r| r.get(0)).unwrap_or(0);
        let model: String = c.query_row("SELECT model FROM vecs LIMIT 1", [], |r| r.get(0)).unwrap_or_default();
        Ok(json!({ "sources": sources, "types": types, "semantic": { "records": vec_recs, "passages": vec_passages, "model": model } }))
    })
    .unwrap_or_else(|_| json!({ "sources": [], "types": [] }))
}

// ===================== Présentation pour le modèle =====================

fn type_label(t: &str, en: bool) -> &'static str {
    TYPES.iter().find(|x| x.0 == t).map(|x| if en { x.2 } else { x.1 }).unwrap_or("élément")
}

/// Une fiche en une ou deux lignes lisibles, avec son id pour data_get.
pub fn line(r: &Rec, en: bool, full: bool) -> String {
    let mut head = format!("• {}", r.title);
    if r.start > 0 {
        head.push_str(&format!(" — {}", fmt_date(r.start, en)));
        if r.end > r.start && r.end - r.start < 7 * 86_400_000 && !r.tags.contains("journée") {
            head.push_str(&format!(" → {}", fmt_date(r.end, en).rsplit(' ').next().unwrap_or("")));
        }
    }
    let mut meta = vec![format!("{} · {}", type_label(&r.kind, en), r.app)];
    for (k, v) in [("statut", &r.status), ("qui", &r.people), ("lieu", &r.place), ("tags", &r.tags)] {
        if !v.is_empty() {
            meta.push(if en { v.to_string() } else { format!("{k} : {v}") });
        }
    }
    let text = if full {
        clip(&r.text, 12_000)
    } else if r.hit.contains('«') || r.hit.starts_with('≈') {
        clip(&r.hit, 320)
    } else {
        clip(&r.text, 220)
    };
    let mut out = format!("{head}\n  {}  [id {}]", meta.join(" · "), r.id);
    if !text.is_empty() {
        out.push_str(&format!("\n  {text}"));
    }
    if full && !r.rref.is_empty() {
        out.push_str(&format!("\n  emplacement : {}", r.rref));
    }
    if !r.url.is_empty() {
        // L'adresse sert à MONTRER une image ou FOURNIR un fichier, tels quels.
        let hint = match r.kind.as_str() {
            "image" => format!("![{}]({})", r.title, r.url),
            _ => format!("[{}]({})", r.title, r.url),
        };
        out.push_str(&format!("\n  {} : {hint}", if en { "link" } else { "lien" }));
    }
    out
}

pub fn render(recs: &[Rec], en: bool, empty: &str) -> String {
    if recs.is_empty() {
        return empty.to_string();
    }
    let head = if recs.len() > 3 { format!("{} {} ({})\n", recs.len(), if en { "results" } else { "résultats" }, facets(recs)) } else { String::new() };
    head + &recs.iter().map(|r| line(r, en, false)).collect::<Vec<_>>().join("\n")
}

/// Période en langage simple → [début, fin[ en ms, heure locale.
///
/// « week » = la semaine CALENDAIRE en cours (lundi → dimanche), passé
/// compris : « les évènements de cette semaine » inclut ceux d'avant-hier.
/// Pour « les 7 prochains jours », `next_7_days` (ou `days`).
pub fn period(p: &str, days: i64) -> (i64, i64) {
    use chrono::{Datelike, Local, TimeZone};
    let today = Local::now().date_naive();
    let ms = |d: chrono::NaiveDate| Local.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap()).single().map(|x| x.timestamp_millis()).unwrap_or_else(now_ms);
    let start = ms(today);
    let day = 86_400_000;
    let monday = ms(today - chrono::Duration::days(today.weekday().num_days_from_monday() as i64));
    let first_of_month = ms(today.with_day(1).unwrap_or(today));
    let next_month = ms(if today.month() == 12 {
        chrono::NaiveDate::from_ymd_opt(today.year() + 1, 1, 1).unwrap_or(today)
    } else {
        chrono::NaiveDate::from_ymd_opt(today.year(), today.month() + 1, 1).unwrap_or(today)
    });
    match p.trim().to_lowercase().replace(' ', "_").as_str() {
        "today" | "aujourdhui" | "aujourd'hui" => (start, start + day),
        "tomorrow" | "demain" => (start + day, start + 2 * day),
        "yesterday" | "hier" => (start - day, start),
        "week" | "this_week" | "semaine" | "cette_semaine" => (monday, monday + 7 * day),
        "last_week" | "semaine_derniere" | "semaine_dernière" => (monday - 7 * day, monday),
        "next_week" | "semaine_prochaine" => (monday + 7 * day, monday + 14 * day),
        "weekend" | "week-end" => (monday + 5 * day, monday + 7 * day),
        "past_week" | "last_7_days" => (start - 6 * day, start + day),
        "next_7_days" | "upcoming" | "a_venir" | "à_venir" => (start, start + 7 * day),
        "month" | "mois" | "this_month" | "ce_mois" => (first_of_month, next_month),
        "next_30_days" => (start, start + 30 * day),
        _ => {
            let n = if days > 0 { days.min(366) } else { 7 };
            (start, start + n * day)
        }
    }
}

// ===================== Commandes =====================

/// `lumenmedia://localhost/<sb>/<chemin>` → chemin sur disque (dans la sandbox).
pub fn resolve_url(app: &tauri::AppHandle, url: &str) -> Result<PathBuf, String> {
    let (sb, rel) = crate::media::split(url).ok_or("adresse de fichier invalide")?;
    crate::sandbox::sandbox_file_path(app, &sb, &rel)
}

/// Ouvre un fichier du coffre (lien cliqué dans une réponse) avec l'app du
/// système — PDF, archives, binaires que les visionneuses de Lumen ne lisent pas.
#[tauri::command]
pub fn datahub_open_file(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let state = app.state::<crate::session::SessionState>();
    if !crate::session::is_unlocked(&app, state.inner()) {
        return Err("session verrouillée".into());
    }
    let path = resolve_url(&app, &url)?;
    if !path.is_file() {
        return Err("fichier introuvable".into());
    }
    app.opener().open_path(path.to_string_lossy().to_string(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn datahub_overview(app: tauri::AppHandle) -> Value {
    let mut o = overview(&app);
    o["settings"] = serde_json::to_value(settings(&app)).unwrap_or_default();
    o
}

#[tauri::command]
pub fn datahub_settings_set(app: tauri::AppHandle, settings: HubSettings) -> Result<(), String> {
    let p = settings_path(&app).ok_or("dossier introuvable")?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&p, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let a = app.clone();
    std::thread::spawn(move || {
        refresh(&a, true);
    });
    Ok(())
}

#[tauri::command(async)]
pub fn datahub_reindex(app: tauri::AppHandle) -> usize {
    if let Ok(mut g) = SIGS.lock() {
        *g = None;
    }
    let n = refresh(&app, true);
    let a = app.clone();
    std::thread::spawn(move || while embed_pending(&a) > 0 {});
    n
}

#[derive(Deserialize, Default)]
pub struct QueryArgs {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(default)]
    pub from: i64,
    #[serde(default)]
    pub to: i64,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub limit: usize,
    #[serde(default)]
    pub order: String,
    #[serde(default)]
    pub source: String,
}

impl From<QueryArgs> for Query {
    fn from(a: QueryArgs) -> Self {
        Query { text: a.text, types: a.types, apps: a.apps, from: a.from, to: a.to, status: a.status, limit: a.limit, order: a.order, source: a.source }
    }
}

/// Requête « à la façon des outils » pour les appareils (route du compagnon) :
/// mode search | agenda | tasks | metrics, avec les mêmes filtres.
pub fn device_query(app: &tauri::AppHandle, profile: &str, mode: &str, mut a: QueryArgs, period_name: &str) -> Result<Vec<Rec>, String> {
    // Fiche complète (texte intégral) : `text` porte l'id.
    if mode == "get" {
        return Ok(get_as(app, profile, a.text.trim()).into_iter().collect());
    }
    if !period_name.is_empty() {
        let (f, t) = period(period_name, 0);
        a.from = f;
        a.to = t;
    }
    match mode {
        "agenda" => {
            if a.from == 0 {
                let (f, t) = period("week", 0);
                a.from = f;
                a.to = t;
            }
            a.types = vec!["event".into(), "task".into()];
            a.order = "start".into();
        }
        "tasks" => {
            a.types = vec!["task".into()];
            if a.status.is_empty() {
                a.status = "open".into();
            }
            a.order = "start".into();
        }
        "metrics" => a.types = vec!["metric".into(), "value".into()],
        _ => {}
    }
    if a.limit == 0 {
        a.limit = 50;
    }
    if mode == "source" && a.order.is_empty() {
        a.order = "recent".into();
    }
    query_as(app, profile, &a.into())
}

#[tauri::command(async)]
pub fn datahub_query(app: tauri::AppHandle, args: QueryArgs) -> Result<Vec<Rec>, String> {
    query(&app, &args.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_labels() {
        assert_eq!(to_ms(&json!(1781899200)), 1_781_899_200_000);
        assert_eq!(to_ms(&json!(1781899200000i64)), 1_781_899_200_000);
        assert_eq!(parse_date("2026-09-30T20:00:00Z"), 1_790_798_400_000);
        assert!(parse_date("Wed, 23 Sep 2026 09:35:05 +0000") > 0);
        assert_eq!(readable(&json!({"a": "x", "b": 2})), "a : x, b : 2");
        assert_eq!(fts_expr("mes données de sommeil"), "\"donnée\"* OR \"sommeil\"*");
        assert_eq!(fts_expr("note Pokémons"), "\"note\"* OR \"Pokémon\"*");
        let c = chunks("Titre", &"Phrase courte. ".repeat(200));
        assert!(c.len() > 2 && c.iter().all(|x| x.starts_with("Titre\n") && x.chars().count() <= 820));
        assert_eq!(from_blob(&to_blob(&[1.5, -2.0])), vec![1.5, -2.0]);
        use chrono::{Datelike, TimeZone};
        let (a, b) = period("week", 0);
        let mon = chrono::Local.timestamp_millis_opt(a).unwrap();
        assert_eq!(mon.weekday(), chrono::Weekday::Mon);
        assert_eq!(b - a, 7 * 86_400_000);
        assert!(a <= now_ms() && now_ms() < b);
        assert_eq!(split_type_words("ma note sur les Pokémons"), ("ma sur les Pokémons".to_string(), vec!["note".to_string()]));
    }

    #[test]
    fn iphone_vault_becomes_records() {
        let e = |key: &str, v: Value, kind: &str| crate::vault::Entry { key: key.into(), kind: kind.into(), value: v, updated_ms: 1, device: "iPhone".into(), deleted: false, history: vec![] };
        let recs = vault_recs(&[
            e("sante/sommeil_h", json!(8.3), "number"),
            e("agenda/iphone", json!([{ "titre": "Anniversaire", "debut": "2026-09-30T20:00:00Z", "fin": "2026-10-01T19:59:59Z", "journee": true, "lieu": "", "agenda": "Anniversaires" }]), "list"),
        ]);
        assert_eq!(recs[0].title, "Sommeil de la dernière nuit");
        assert_eq!(recs[0].text, "8.3 h");
        assert_eq!(recs[0].kind, "metric");
        assert_eq!(recs[1].kind, "event");
        assert_eq!(recs[1].title, "Anniversaire");
        assert!(recs[1].start > 0);
    }
}

#[cfg(test)]
mod real_data {
    use super::*;
    /// `cargo test datahub::real_data -- --ignored --nocapture` : connecteurs sur les données réelles.
    #[test]
    #[ignore]
    fn connectors_on_real_data() {
        let d = PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Application Support/com.lumen.app");
        let show = |n: &str, v: Vec<Rec>| {
            println!("== {n}: {}", v.len());
            for r in v.iter().take(2) {
                println!("{}", line(r, false, false));
            }
        };
        show("kanban", kanban(&d.join("kanban.json")));
        show("rappels", reminders(&d.join("reminders.json")));
        show("notes", notes(&d.join("app-state/notes.json")));
        show("contacts", contacts(&d.join("contacts.json")));
        show("messagerie", inbox(&d.join("inbox.json")));
        show("courrier", mail(&d.join("mail.json")));
        show("agents", agents(&d.join("agents.json")));
        show("bases", tables(&d.join("tables.db")));
        show("corpus", corpus(&d.join("rag.db")));
        show("studies", generic_state("studies", &d.join("app-state/studies.json")));
        show("carte", generic_state("carte", &d.join("app-state/carte.json")));
        let st: Value = read_json(&d.join("vault/default.json"));
        let entries: Vec<crate::vault::Entry> = st["entries"].as_object().map(|m| m.values().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect()).unwrap_or_default();
        show("coffre", vault_recs(&entries));
        for f in ["sandboxes/sandbox-test-1781108851/root/Présentation.lumenkey", "sandboxes/sandbox-test-1781108851/root/Test_OMR.lumensheet", "sandboxes/projets-1789643876/root/Mini_PC.lumenpages"] {
            let v: Value = read_json(&d.join(f));
            let t = lumen_doc_text(&v);
            println!("== {f}: {} car.\n{}", t.len(), t.chars().take(300).collect::<String>());
        }
        println!("{}", media_url("sb1", "Photos/été 2026.png"));
        // Moteur : ET puis OU, BM25, extrait, sur l'index réel.
        let c = Connection::open(d.join("vault/hub.db")).unwrap();
        for q in ["candidature SPL Sudec", "note Pokémons", "Raspberry présentation"] {
            for e in [fts_terms(q).join(" AND "), fts_terms(q).join(" OR ")] {
                let ids: Vec<(String, String)> = c.prepare(&format!("SELECT id, snippet(recs, 5, '«', '»', '…', 12) FROM recs WHERE recs MATCH '{{title text tags people place}} : ({})' ORDER BY bm25(recs, 0,0,0,0, 10.0, 1.0, 3.0, 3.0, 2.0) LIMIT 3", e.replace('\'', "''"))).unwrap()
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().flatten().collect();
                println!("[{q}] {e} → {ids:?}");
                if !ids.is_empty() { break; }
            }
        }
    }
}

#[cfg(test)]
mod vault_catalog_tests {
    use super::*;
    #[test]
    fn catalog_preserves_profile_scope_source_boundaries_and_pagination() {
        let c=Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE sources(id TEXT,scope TEXT,label_fr TEXT,count INTEGER); CREATE TABLE recs(id TEXT,scope TEXT,title TEXT,text TEXT,ref TEXT,updated INTEGER);").unwrap();
        for (source,scope) in [("notes","*"),("fichiers:atelier","alice"),("fichiers:autre","bob"),("coffre","alice")] {
            c.execute("INSERT INTO sources VALUES (?1,?2,?1,1)",params![source,scope]).unwrap();
        }
        for i in 0..125 {
            c.execute("INSERT INTO recs VALUES (?1,'alice','Jardin','aromates','atelier',?2)",params![format!("fichiers:atelier:{i}"),i]).unwrap();
        }
        for (id,scope) in [("notes:one","*"),("fichiers:autre:secret","bob"),("coffre:private","alice"),("fichiers:atelierbis:test","alice")] {
            c.execute("INSERT INTO recs VALUES (?1,?2,'secret','','',0)",params![id,scope]).unwrap();
        }
        let (sources,ids,total)=catalog_rows(&c,"alice","fichiers:atelier","AROMATES",60).unwrap();
        assert_eq!(total,125); assert_eq!(ids.len(),60);assert_eq!(ids[0],"fichiers:atelier:64");
        assert!(!sources.iter().any(|s|s["id"]=="fichiers:autre"||s["id"]=="coffre"));
        let (_,ids,total)=catalog_rows(&c,"alice","","",0).unwrap();assert_eq!(total,127);assert!(ids.iter().all(|id|!id.contains("private")&&!id.contains("autre")));
        assert_eq!(catalog_rows(&c,"alice","fichiers:atelier","' OR 1=1 --",0).unwrap().2,0);
        assert_eq!(catalog_rows(&c,"bob","fichiers:atelier","",0).unwrap().2,0);
    }
}
