//! **Documents vivants** : un bloc d'une note, une feuille Calc ou une zone de
//! texte Opus qu'un agent tient à jour tout seul, selon un rythme et des
//! sources définies (façon « Pages » de ChatGPT Space — mais local d'abord).
//!
//! ## Principe
//!
//! Un *bloc vivant* est une entrée du registre (`living.json`, par profil) :
//! où il vit (note / fichier de sandbox + cible), QUI le tient à jour (un agent,
//! ou Lumen lui-même), sa consigne, ses sources et son rythme (CRON 6 champs,
//! UTC, comme les agents).
//!
//! À chaque passage :
//! 1. Lumen **collecte les sources** lui-même, par les outils natifs (coffre,
//!    agenda, tâches, web, actualités, météo, pages, notes, fichiers) — le bloc
//!    reste utile même si l'agent n'a pas ces outils ;
//! 2. il confie la réécriture à l'agent (`agents::run_prompt`, donc journal,
//!    compte rendu, garde-fous) — ou au modèle des Réglages sans agent ;
//! 3. **Lumen seul écrit le fichier**, et seulement la zone du bloc : l'agent
//!    n'a besoin d'aucun droit sur la sandbox du document, et ne peut pas
//!    toucher au reste.
//!
//! La même mécanique sert la délégation ponctuelle d'un `@Agent` tapé dans un
//! document (`living_delegate`) : contexte du document + demande → texte à
//! insérer à cet endroit.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex as StdMutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use tokio_cron_scheduler::{Job, JobScheduler};

const SOURCE_MAX: usize = 3500;
const CURRENT_MAX: usize = 6000;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Une source à consulter avant chaque mise à jour.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Source {
    /// `data` · `agenda` · `tasks` · `web` · `page` · `news` · `weather` ·
    /// `note` · `file`.
    pub kind: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct LiveBlock {
    pub id: String,
    /// `note` (Notes), `sheet` (feuille Calc), `doc` (zone de texte Opus).
    pub kind: String,
    #[serde(default)]
    pub title: String,
    /// Note concernée (`kind = note`).
    #[serde(default)]
    pub note_id: String,
    /// Fichier concerné (`sheet` / `doc`).
    #[serde(default)]
    pub sandbox_id: String,
    #[serde(default)]
    pub path: String,
    /// Nom de la feuille (`sheet`) ou id de l'élément (`doc`).
    #[serde(default)]
    pub target: String,
    /// Agent qui tient le bloc (vide ⇒ Lumen, modèle des Réglages).
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub instruction: String,
    #[serde(default)]
    pub sources: Vec<Source>,
    /// CRON 6 champs (UTC). Vide ⇒ à la demande seulement.
    #[serde(default)]
    pub cron: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub last_run: u64,
    /// `idle` · `running` · `ok` · `error`.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub last_error: String,
}

fn yes() -> bool {
    true
}

#[derive(Default)]
pub struct LivingState {
    scheduler: Mutex<Option<JobScheduler>>,
}

static REG_LOCK: StdMutex<()> = StdMutex::new(());

// ===================== Registre =====================

fn registry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path())
        .map_err(|e| e.to_string())?
        .join("profiles")
        .join(crate::session::active_profile_id(app));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("living.json"))
}

fn read_all(app: &tauri::AppHandle) -> Vec<LiveBlock> {
    registry_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_all(app: &tauri::AppHandle, list: &[LiveBlock]) -> Result<(), String> {
    let p = registry_path(app)?;
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn update_block(app: &tauri::AppHandle, id: &str, f: impl FnOnce(&mut LiveBlock)) {
    let _g = REG_LOCK.lock();
    let mut list = read_all(app);
    if let Some(b) = list.iter_mut().find(|b| b.id == id) {
        f(b);
        let _ = write_all(app, &list);
    }
    drop(_g);
    let _ = app.emit("living-updated", json!({ "id": id }));
}

// ===================== Sources =====================

async fn collect(app: &tauri::AppHandle, block: &LiveBlock, en: bool) -> String {
    let mut out = Vec::new();
    for s in &block.sources {
        let v = s.value.trim();
        let (label, text) = match s.kind.as_str() {
            "data" => (format!("Données Lumen — « {v} »"), tool(app, "data_search", json!({ "query": v }), "").await),
            "agenda" => ("Agenda (7 jours)".to_string(), tool(app, "data_agenda", json!({ "days": 7 }), "").await),
            "tasks" => ("Tâches ouvertes".to_string(), tool(app, "data_tasks", json!({ "status": "open" }), "").await),
            "web" => (format!("Recherche web — « {v} »"), tool(app, "web_search", json!({ "query": v }), "").await),
            "page" => (format!("Page {v}"), tool(app, "web_read_page", json!({ "url": v }), "").await),
            "news" => (format!("Actualités — {}", if v.is_empty() { "à la une" } else { v }), tool(app, "news_headlines", json!({ "topic": v, "count": 8 }), "").await),
            "weather" => (format!("Météo — {v}"), tool(app, "weather_now", json!({ "place": v }), "").await),
            "note" => (format!("Note « {v} »"), note_text(app, v).unwrap_or_else(|| "(note introuvable)".into())),
            "file" => {
                let sb = if block.sandbox_id.is_empty() { String::new() } else { block.sandbox_id.clone() };
                (format!("Fichier {v}"), file_text(app, &sb, v))
            }
            _ => continue,
        };
        out.push(format!("### {label}\n{}", clip(&text, SOURCE_MAX)));
    }
    if out.is_empty() {
        return if en { "(no source configured)".into() } else { "(aucune source définie)".into() };
    }
    out.join("\n\n")
}

async fn tool(app: &tauri::AppHandle, name: &str, args: Value, sandbox: &str) -> String {
    let (text, ok) = crate::native_tools::exec(app, name, &args, sandbox).await;
    if ok { text } else { format!("(indisponible : {text})") }
}

fn file_text(app: &tauri::AppHandle, sandbox_id: &str, rel: &str) -> String {
    // `sandbox:chemin` ou chemin dans la sandbox du document.
    let (sb, path) = match rel.split_once(':') {
        Some((a, b)) if !a.contains('/') => (crate::sandbox::id_for_name(app, a).unwrap_or_else(|| a.to_string()), b.to_string()),
        _ => (sandbox_id.to_string(), rel.to_string()),
    };
    if sb.is_empty() {
        return "(sandbox inconnue)".into();
    }
    match crate::sandbox::sandbox_read_file_unchecked(app.clone(), sb, path) {
        Ok(f) if !f.binary => f.content,
        Ok(_) => "(fichier binaire)".into(),
        Err(e) => format!("(illisible : {e})"),
    }
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

// ===================== Notes (app-state/notes.json) =====================

fn notes_load(app: &tauri::AppHandle) -> (Value, Vec<Value>) {
    let raw = crate::storage::app_state_load(app.clone(), "notes".into()).unwrap_or_default();
    let obj: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    let list = obj
        .get("notes.data")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<Vec<Value>>(s).ok())
        .unwrap_or_default();
    (obj, list)
}

fn notes_save(app: &tauri::AppHandle, mut obj: Value, list: &[Value]) -> Result<(), String> {
    obj["notes.data"] = json!(serde_json::to_string(list).map_err(|e| e.to_string())?);
    crate::storage::app_state_save(app.clone(), "notes".into(), obj.to_string())?;
    // L'app Notes ouverte relit son état (cf. lib/app-state.js).
    let _ = app.emit("app-state-changed", json!({ "name": "notes" }));
    Ok(())
}

/// Crée une note (raccourci « Créer une note Lumen »). Renvoie son id.
pub fn create_note(app: &tauri::AppHandle, title: &str, body: &str) -> Result<String, String> {
    let (obj, mut list) = notes_load(app);
    let id = format!("n{}", now_secs());
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    list.insert(0, json!({ "id": id, "title": title.trim(), "body": body, "ts": ts }));
    notes_save(app, obj, &list)?;
    Ok(id)
}

fn note_text(app: &tauri::AppHandle, title_or_id: &str) -> Option<String> {
    let (_, list) = notes_load(app);
    let want = title_or_id.trim().to_lowercase();
    list.iter()
        .find(|n| {
            n.get("id").and_then(|v| v.as_str()) == Some(title_or_id)
                || n.get("title").and_then(|v| v.as_str()).map(|t| t.trim().to_lowercase()) == Some(want.clone())
        })
        .and_then(|n| n.get("body").and_then(|v| v.as_str()).map(String::from))
}

/// Contenu entre `:::live <id>` et la fermeture `:::` correspondante.
fn live_span(body: &str, id: &str) -> Option<(usize, usize, usize)> {
    let open = format!(":::live {id}");
    let start = body.find(&open)?;
    let after_open = body[start..].find('\n').map(|i| start + i + 1).unwrap_or(body.len());
    // Fermeture : première ligne « ::: » seule après l'ouverture.
    let mut pos = after_open;
    for line in body[after_open..].split_inclusive('\n') {
        if line.trim() == ":::" {
            return Some((start, after_open, pos));
        }
        pos += line.len();
    }
    None
}

fn replace_live(body: &str, id: &str, content: &str) -> String {
    match live_span(body, id) {
        Some((_, inner_start, close)) => format!("{}{}\n{}", &body[..inner_start], content.trim_end(), &body[close..]),
        None => format!("{}\n\n:::live {id}\n{}\n:::\n", body.trim_end(), content.trim_end()),
    }
}

fn current_note_block(app: &tauri::AppHandle, b: &LiveBlock) -> (String, String) {
    let (_, list) = notes_load(app);
    let note = list.iter().find(|n| n.get("id").and_then(|v| v.as_str()) == Some(b.note_id.as_str()));
    let title = note.and_then(|n| n.get("title").and_then(|v| v.as_str())).unwrap_or("").to_string();
    let body = note.and_then(|n| n.get("body").and_then(|v| v.as_str())).unwrap_or("");
    let inner = live_span(body, &b.id).map(|(_, s, e)| body[s..e].to_string()).unwrap_or_default();
    (title, inner)
}

fn write_note_block(app: &tauri::AppHandle, b: &LiveBlock, content: &str) -> Result<(), String> {
    let (obj, mut list) = notes_load(app);
    let note = list
        .iter_mut()
        .find(|n| n.get("id").and_then(|v| v.as_str()) == Some(b.note_id.as_str()))
        .ok_or("Note introuvable (supprimée ?)")?;
    let body = note.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let title = note.get("title").cloned().unwrap_or(json!(""));
    let ts = note.get("ts").cloned().unwrap_or(json!(0));
    // Version précédente gardée dans l'historique de la note, comme l'app.
    let mut hist = note.get("history").and_then(|h| h.as_array()).cloned().unwrap_or_default();
    hist.insert(0, json!({ "ts": ts, "title": title, "body": body }));
    hist.truncate(40);
    note["history"] = json!(hist);
    note["body"] = json!(replace_live(&body, &b.id, content));
    note["ts"] = json!(now_secs() * 1000);
    notes_save(app, obj, &list)
}

// ===================== Calc (.lumensheet) =====================

fn read_json_file(app: &tauri::AppHandle, sb: &str, path: &str) -> Result<Value, String> {
    let f = crate::sandbox::sandbox_read_file_unchecked(app.clone(), sb.to_string(), path.to_string())?;
    serde_json::from_str(&f.content).map_err(|e| format!("fichier illisible : {e}"))
}

fn write_json_file(app: &tauri::AppHandle, sb: &str, path: &str, v: &Value) -> Result<(), String> {
    let body = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    crate::sandbox::sandbox_write_file_unchecked(app.clone(), sb.to_string(), path.to_string(), body)
}

fn col_name(mut c: usize) -> String {
    let mut s = String::new();
    loop {
        s.insert(0, (b'A' + (c % 26) as u8) as char);
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    s
}

/// Tableau Markdown (ou CSV / TSV) → lignes de cellules.
pub fn parse_table(text: &str) -> Vec<Vec<String>> {
    let lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let md: Vec<&&str> = lines.iter().filter(|l| l.starts_with('|')).collect();
    if md.len() >= 2 {
        return md
            .iter()
            .filter(|l| !l.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')))
            .map(|l| l.trim_matches('|').split('|').map(|c| c.trim().replace("**", "")).collect())
            .collect();
    }
    let sep = if lines.iter().any(|l| l.contains('\t')) { '\t' } else if lines.iter().any(|l| l.contains(';')) { ';' } else { ',' };
    lines
        .iter()
        .filter(|l| l.contains(sep))
        .map(|l| l.split(sep).map(|c| c.trim().trim_matches('"').to_string()).collect())
        .collect()
}

fn sheet_to_markdown(sheet: &Value) -> String {
    let cells = sheet.get("cells").and_then(|c| c.as_object()).cloned().unwrap_or_default();
    let mut rows: Vec<Vec<String>> = vec![vec![String::new(); 12]; 40];
    let mut max_r = 0;
    let mut max_c = 0;
    for (k, v) in cells {
        let letters: String = k.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
        let num: usize = k[letters.len()..].parse().unwrap_or(0);
        if letters.is_empty() || num == 0 {
            continue;
        }
        let c = letters.chars().fold(0usize, |a, ch| a * 26 + (ch as usize - 'A' as usize + 1)) - 1;
        let r = num - 1;
        if r < 40 && c < 12 {
            rows[r][c] = v.as_str().map(String::from).unwrap_or_else(|| v.to_string());
            max_r = max_r.max(r + 1);
            max_c = max_c.max(c + 1);
        }
    }
    if max_r == 0 {
        return "(feuille vide)".into();
    }
    rows.truncate(max_r);
    let mut out = String::new();
    for (i, r) in rows.iter().enumerate() {
        out.push_str(&format!("| {} |\n", r[..max_c].join(" | ")));
        if i == 0 {
            out.push_str(&format!("|{}\n", " --- |".repeat(max_c)));
        }
    }
    out
}

fn sheet_ref<'a>(doc: &'a mut Value, name: &str) -> Option<&'a mut Value> {
    let sheets = doc.pointer_mut("/doc/sheets")?.as_array_mut()?;
    if !sheets.iter().any(|s| s.get("name").and_then(|n| n.as_str()) == Some(name)) {
        sheets.push(json!({ "name": name, "cells": {}, "fmt": {}, "widths": {}, "cols": 26, "rows": 100, "source": null }));
    }
    sheets.iter_mut().find(|s| s.get("name").and_then(|n| n.as_str()) == Some(name))
}

fn current_sheet(app: &tauri::AppHandle, b: &LiveBlock) -> String {
    match read_json_file(app, &b.sandbox_id, &b.path) {
        Ok(mut v) => sheet_ref(&mut v, &b.target).map(|s| sheet_to_markdown(s)).unwrap_or_default(),
        Err(e) => format!("({e})"),
    }
}

fn write_sheet(app: &tauri::AppHandle, b: &LiveBlock, content: &str) -> Result<(), String> {
    let rows = parse_table(content);
    if rows.is_empty() {
        return Err("La réponse ne contient pas de tableau exploitable.".into());
    }
    let mut v = read_json_file(app, &b.sandbox_id, &b.path)?;
    let sheet = sheet_ref(&mut v, &b.target).ok_or("Classeur invalide")?;
    let mut cells = serde_json::Map::new();
    for (r, row) in rows.iter().enumerate().take(1000) {
        for (c, val) in row.iter().enumerate().take(52) {
            if !val.is_empty() {
                cells.insert(format!("{}{}", col_name(c), r + 1), json!(val));
            }
        }
    }
    sheet["cells"] = Value::Object(cells);
    sheet["live"] = json!({ "id": b.id, "updatedAt": now_secs() * 1000 });
    v["updatedAt"] = json!(now_secs() * 1000);
    write_json_file(app, &b.sandbox_id, &b.path, &v)
}

// ===================== Opus (.lumenpages / .lumenkey) =====================

fn find_element<'a>(doc: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    let pages = doc.pointer_mut("/doc/pages")?.as_array_mut()?;
    for p in pages.iter_mut() {
        if let Some(els) = p.get_mut("elements").and_then(|e| e.as_array_mut()) {
            if let Some(el) = els.iter_mut().find(|e| e.get("id").and_then(|v| v.as_str()) == Some(id)) {
                return Some(el);
            }
        }
    }
    None
}

fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in html.replace("</p>", "\n").replace("<br>", "\n").replace("</li>", "\n").chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")
}

/// Markdown → HTML pour une zone de texte Opus. Tout HTML brut du modèle est
/// rendu comme TEXTE (jamais interprété).
pub fn markdown_html(md: &str) -> String {
    use pulldown_cmark::{html, Event, Options, Parser};
    let parser = Parser::new_ext(md, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS)
        .map(|ev| match ev {
            Event::Html(t) | Event::InlineHtml(t) => Event::Text(t),
            other => other,
        });
    let mut out = String::new();
    html::push_html(&mut out, parser);
    out
}

fn current_doc(app: &tauri::AppHandle, b: &LiveBlock) -> String {
    match read_json_file(app, &b.sandbox_id, &b.path) {
        Ok(mut v) => find_element(&mut v, &b.target)
            .and_then(|el| el.get("html").and_then(|h| h.as_str()).map(html_to_text))
            .unwrap_or_default(),
        Err(e) => format!("({e})"),
    }
}

fn write_doc(app: &tauri::AppHandle, b: &LiveBlock, content: &str) -> Result<(), String> {
    let mut v = read_json_file(app, &b.sandbox_id, &b.path)?;
    let el = find_element(&mut v, &b.target).ok_or("Zone de texte introuvable dans le document.")?;
    el["html"] = json!(markdown_html(content));
    el["live"] = json!({ "id": b.id, "updatedAt": now_secs() * 1000 });
    v["updatedAt"] = json!(now_secs() * 1000);
    write_json_file(app, &b.sandbox_id, &b.path, &v)
}

// ===================== Exécution =====================

/// Retire l'emballage qu'un modèle ajoute volontiers (``` autour, phrase
/// d'annonce « Voici… »).
fn clean_output(raw: &str) -> String {
    // Le verdict du vérificateur d'agent n'a pas sa place dans le document.
    let raw = raw.split("\n\n⚠️ Vérification refusée").next().unwrap_or(raw);
    let mut s = raw.trim().to_string();
    if s.starts_with("```") {
        if let Some(nl) = s.find('\n') {
            s = s[nl + 1..].to_string();
        }
        if let Some(end) = s.rfind("```") {
            s.truncate(end);
        }
    }
    let first = s.lines().next().unwrap_or("").to_lowercase();
    if (first.starts_with("voici") || first.starts_with("here is") || first.starts_with("here's")) && first.ends_with(':') {
        s = s.lines().skip(1).collect::<Vec<_>>().join("\n");
    }
    s.trim().to_string()
}

fn format_rule(kind: &str, en: bool) -> &'static str {
    match (kind, en) {
        ("sheet", false) => "Rends UNIQUEMENT un tableau Markdown (ligne d'en-tête comprise), sans phrase d'introduction ni commentaire : il remplacera le contenu de la feuille.",
        ("sheet", true) => "Return ONLY a Markdown table (header row included), with no introduction or comment: it will replace the sheet's content.",
        (_, false) => "Rends UNIQUEMENT le nouveau contenu du bloc, en Markdown, sans phrase d'introduction ni commentaire : il remplacera le bloc tel quel. N'appelle aucun outil pour écrire : Lumen s'en charge.",
        (_, true) => "Return ONLY the block's new content, in Markdown, with no introduction or comment: it will replace the block as is. Do not call any tool to write: Lumen does it.",
    }
}

/// Fait travailler l'agent choisi (ou le modèle des Réglages) sur `task`.
fn ask(app: &tauri::AppHandle, agent_id: &str, task: &str, _en: bool) -> Result<String, String> {
    // Harnais léger (assist.rs) : la personnalité et les outils de lecture de
    // l'agent, sans le protocole de tâche (compte rendu JSON, vérificateur,
    // rattrapages) qui égarait les petits modèles locaux.
    crate::assist::answer(app, agent_id, task, "", "").map(|a| a.text)
}

async fn run_block(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let block = read_all(&app).into_iter().find(|b| b.id == id).ok_or("Bloc vivant introuvable")?;
    update_block(&app, &id, |b| {
        b.status = "running".into();
        b.last_error = String::new();
    });
    let en = crate::telegram::is_en(&app);
    let sources = collect(&app, &block, en).await;
    let (doc_title, current) = match block.kind.as_str() {
        "note" => current_note_block(&app, &block),
        "sheet" => (block.path.clone(), current_sheet(&app, &block)),
        _ => (block.path.clone(), current_doc(&app, &block)),
    };
    let today = chrono_like_today();
    let task = if en {
        format!(
            "You keep a LIVING block up to date in Lumen.\nDocument: {doc_title}\nBlock: {}\nDate: {today}\n\nInstruction:\n{}\n\nCurrent content of the block:\n{}\n\nSources gathered by Lumen just now:\n{sources}\n\n{}",
            block.title, block.instruction, clip(&current, CURRENT_MAX), format_rule(&block.kind, en)
        )
    } else {
        format!(
            "Tu tiens à jour un bloc VIVANT dans Lumen.\nDocument : {doc_title}\nBloc : {}\nDate : {today}\n\nConsigne :\n{}\n\nContenu actuel du bloc :\n{}\n\nSources collectées par Lumen à l'instant :\n{sources}\n\n{}",
            block.title, block.instruction, clip(&current, CURRENT_MAX), format_rule(&block.kind, en)
        )
    };
    let (app2, agent, task2) = (app.clone(), block.agent_id.clone(), task.clone());
    let result = tokio::task::spawn_blocking(move || ask(&app2, &agent, &task2, en))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    let outcome = result.and_then(|raw| {
        let content = clean_output(&raw);
        if content.is_empty() {
            return Err("réponse vide".into());
        }
        match block.kind.as_str() {
            "note" => write_note_block(&app, &block, &content),
            "sheet" => write_sheet(&app, &block, &content),
            _ => write_doc(&app, &block, &content),
        }
        .map(|_| content)
    });
    match &outcome {
        Ok(_) => update_block(&app, &id, |b| {
            b.status = "ok".into();
            b.last_run = now_secs();
        }),
        Err(e) => {
            let e = e.clone();
            update_block(&app, &id, |b| {
                b.status = "error".into();
                b.last_run = now_secs();
                b.last_error = e;
            })
        }
    }
    let _ = app.emit(
        "living-updated",
        json!({ "id": id, "kind": block.kind, "noteId": block.note_id, "sandboxId": block.sandbox_id, "path": block.path, "ok": outcome.is_ok() }),
    );
    outcome
}

fn chrono_like_today() -> String {
    // Date civile UTC (jour/mois/année) sans dépendance supplémentaire.
    let days = now_secs() / 86_400;
    let (mut y, mut d) = (1970u64, days);
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let len = if leap { 366 } else { 365 };
        if d < len {
            break;
        }
        d -= len;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let months = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0;
    while d >= months[m] {
        d -= months[m];
        m += 1;
    }
    format!("{:02}/{:02}/{y}", d + 1, m + 1)
}

// ===================== Planification =====================

pub async fn reschedule(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<LivingState>();
    let mut guard = state.scheduler.lock().await;
    if let Some(mut s) = guard.take() {
        let _ = s.shutdown().await;
    }
    let sched = JobScheduler::new().await.map_err(|e| e.to_string())?;
    for b in read_all(&app) {
        if !b.enabled || b.cron.trim().is_empty() {
            continue;
        }
        let (app_job, id) = (app.clone(), b.id.clone());
        let job = Job::new_async(b.cron.as_str(), move |_u, _l| {
            let (a, i) = (app_job.clone(), id.clone());
            Box::pin(async move {
                let _ = run_block(a, i).await;
            })
        });
        if let Ok(j) = job {
            let _ = sched.add(j).await;
        }
    }
    sched.start().await.map_err(|e| e.to_string())?;
    *guard = Some(sched);
    Ok(())
}

pub fn autostart(app: &tauri::AppHandle) {
    // Au démarrage, aucune délégation @Agent ne peut être en cours : un
    // `:::working` restant vient d'un travail interrompu (Lumen quitté).
    let _ = heal_stale_working(app);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = reschedule(app2).await;
    });
}

/// `:::working <Agent>\n<demande>\n:::` → `@<Agent> <demande>` (relançable).
fn heal_working_markers(body: &str) -> Option<String> {
    if !body.contains(":::working ") {
        return None;
    }
    let mut out = String::with_capacity(body.len());
    let mut lines = body.split_inclusive('\n').peekable();
    let mut changed = false;
    while let Some(line) = lines.next() {
        if let Some(name) = line.trim_end().strip_prefix(":::working ") {
            let mut req = Vec::new();
            let mut closed = false;
            for l in lines.by_ref() {
                if l.trim() == ":::" { closed = true; break; }
                req.push(l.trim().to_string());
            }
            if closed {
                out.push_str(&format!("@{} {}\n", name.trim(), req.join(" ").trim()));
                changed = true;
                continue;
            }
            out.push_str(line);
            for r in req { out.push_str(&r); out.push('\n'); }
            continue;
        }
        out.push_str(line);
    }
    changed.then_some(out)
}

fn heal_stale_working(app: &tauri::AppHandle) -> Result<(), String> {
    let (obj, mut list) = notes_load(app);
    let mut changed = false;
    for n in list.iter_mut() {
        let body = n.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if let Some(fixed) = heal_working_markers(&body) {
            n["body"] = json!(fixed);
            changed = true;
        }
    }
    if changed { notes_save(app, obj, &list) } else { Ok(()) }
}

#[cfg(test)]
mod working_tests {
    use super::*;
    #[test]
    fn marqueur_orphelin_redevient_une_ligne_at() {
        let b = "Intro\n:::working Majordome\nRésume la réunion\n:::\nSuite\n";
        assert_eq!(heal_working_markers(b).unwrap(), "Intro\n@Majordome Résume la réunion\nSuite\n");
        assert!(heal_working_markers("rien\n:::agent X\nok\n:::\n").is_none());
    }
}

// ===================== Commandes =====================

#[tauri::command]
pub fn living_list(app: tauri::AppHandle) -> Vec<LiveBlock> {
    read_all(&app)
}

/// Crée ou met à jour un bloc. Configurer ce qu'un agent écrira seul dans vos
/// documents est une action sensible : bureau verrouillé, il faut le mot de
/// passe de session (cf. `session::config_allowed`).
#[tauri::command]
pub async fn living_save(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    block: LiveBlock,
) -> Result<LiveBlock, String> {
    if !crate::session::config_allowed(&app, session.inner()) {
        return Err("SESSION_LOCKED: le mot de passe de session est requis pour configurer un document vivant.".into());
    }
    if !["note", "sheet", "doc"].contains(&block.kind.as_str()) {
        return Err("Type de bloc inconnu".into());
    }
    let mut block = block;
    let saved = {
        let _g = REG_LOCK.lock();
        let mut list = read_all(&app);
        if block.id.is_empty() {
            let mut raw = [0u8; 4];
            let _ = getrandom::getrandom(&mut raw);
            block.id = format!("lv{}{:02x}{:02x}{:02x}{:02x}", now_secs() % 100_000, raw[0], raw[1], raw[2], raw[3]);
            block.created = now_secs();
            block.status = "idle".into();
            list.push(block.clone());
        } else if let Some(slot) = list.iter_mut().find(|b| b.id == block.id) {
            block.last_run = slot.last_run;
            block.status = slot.status.clone();
            block.last_error = slot.last_error.clone();
            block.created = slot.created;
            *slot = block.clone();
        } else {
            list.push(block.clone());
        }
        write_all(&app, &list)?;
        block
    };
    reschedule(app.clone()).await?;
    let _ = app.emit("living-updated", json!({ "id": saved.id }));
    Ok(saved)
}

#[tauri::command]
pub async fn living_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    {
        let _g = REG_LOCK.lock();
        let mut list = read_all(&app);
        list.retain(|b| b.id != id);
        write_all(&app, &list)?;
    }
    reschedule(app.clone()).await?;
    let _ = app.emit("living-updated", json!({ "id": id, "deleted": true }));
    Ok(())
}

/// Mise à jour immédiate (bouton « Actualiser »). Renvoie le nouveau contenu.
#[tauri::command]
pub async fn living_run(app: tauri::AppHandle, id: String) -> Result<String, String> {
    run_block(app, id).await
}

/// Délégation ponctuelle d'un `@Agent` tapé dans un document : l'agent reçoit
/// le document (tronqué) et la demande, et rend le texte à insérer.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn living_delegate(
    app: tauri::AppHandle,
    agent: String,
    request: String,
    title: String,
    context: String,
    format: Option<String>,
    note_id: Option<String>,
    mark: Option<String>,
    agent_name: Option<String>,
) -> Result<String, String> {
    let res = delegate_inner(app.clone(), agent, request.clone(), title, context, format).await;
    // Notes : c'est LUMEN qui remplace le marqueur `:::working` dans la note,
    // pas la page. Avant, si la vue était fermée, rechargée, ou si l'on
    // changeait de note pendant que l'agent travaillait, la réponse se perdait
    // et le bloc « … écrit la suite » restait affiché pour toujours.
    if let (Some(note), Some(mark)) = (note_id.filter(|n| !n.is_empty()), mark.filter(|m| !m.is_empty())) {
        let name = agent_name.unwrap_or_default();
        let replacement = match &res {
            Ok(out) => format!(":::agent {name}\n{}\n:::", out.trim()),
            Err(_) => format!("@{name} {request}"),
        };
        let _ = note_replace_mark(&app, &note, &mark, &replacement);
    }
    res
}

/// Remplace `mark` par `replacement` dans la note `note_id`, s'il y est encore
/// (la page a pu le faire elle-même entre-temps : on ne double rien).
fn note_replace_mark(app: &tauri::AppHandle, note_id: &str, mark: &str, replacement: &str) -> Result<bool, String> {
    let (obj, mut list) = notes_load(app);
    let Some(note) = list.iter_mut().find(|n| n.get("id").and_then(|v| v.as_str()) == Some(note_id)) else {
        return Ok(false);
    };
    let body = note.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if !body.contains(mark) {
        return Ok(false);
    }
    note["body"] = json!(body.replacen(mark, replacement, 1));
    note["ts"] = json!(now_secs() * 1000);
    notes_save(app, obj, &list)?;
    Ok(true)
}

pub(crate) async fn delegate_inner(
    app: tauri::AppHandle,
    agent: String,
    request: String,
    title: String,
    context: String,
    format: Option<String>,
) -> Result<String, String> {
    let en = crate::telegram::is_en(&app);
    let kind = format.unwrap_or_else(|| "text".into());
    let rule = match (kind == "table", en) {
        (true, _) => format_rule("sheet", en),
        (false, false) => "Rends UNIQUEMENT le texte à insérer, en Markdown, sans introduction ni commentaire.",
        (false, true) => "Return ONLY the text to insert, in Markdown, with no introduction or comment.",
    };
    let context = if title.trim().is_empty() { context } else { format!("# {title}\n\n{context}") };
    let app2 = app.clone();
    let out = tokio::task::spawn_blocking(move || crate::assist::answer(&app2, &agent, &request, &context, rule))
        .await
        .map_err(|e| e.to_string())??
        .text;
    let out = clean_output(&out);
    if out.is_empty() {
        Err("réponse vide".into())
    } else if looks_like_refusal(&out) {
        // Un refus (« je ne peux pas accéder au document… ») n'a rien à faire
        // DANS le document : la ligne @ est rendue et le motif part en toast.
        Err(clip(&out, 240))
    } else {
        Ok(out)
    }
}

/// Markdown → HTML sûr (Opus insère le résultat d'un @agent dans une zone).
#[tauri::command]
pub fn living_markdown_html(markdown: String) -> String {
    markdown_html(&markdown)
}

/// Tableau Markdown / CSV → lignes (Calc insère le résultat d'un @agent).
#[tauri::command]
pub fn living_parse_table(text: String) -> Vec<Vec<String>> {
    parse_table(&text)
}

// ===================== Fichiers de la suite (intégrations) =====================

const OFFICE_EXT: [&str; 6] = ["lumenpages", "lumenkey", "lumensheet", "docx", "pptx", "xlsx"];

/// Documents, présentations et classeurs de toutes les sandboxes : de quoi
/// choisir un fichier à citer ou intégrer dans une note.
#[tauri::command]
pub fn living_office_files(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
) -> Result<Vec<Value>, String> {
    crate::session::require_unlocked(&app, session.inner())?;
    let mut out = Vec::new();
    for sb in crate::sandbox::sandbox_list_unchecked(&app)? {
        let mut stack = vec![(String::new(), 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(entries) = crate::sandbox::sandbox_read_dir_unchecked(&app, &sb.id, &dir) else { continue };
            for e in entries {
                if e.name.starts_with("._") || e.name.starts_with('.') {
                    continue;
                }
                if e.is_dir {
                    if depth < 4 {
                        stack.push((e.path.clone(), depth + 1));
                    }
                    continue;
                }
                let ext = e.name.rsplit('.').next().unwrap_or("").to_lowercase();
                if OFFICE_EXT.contains(&ext.as_str()) {
                    out.push(json!({ "sandboxId": sb.id, "sandbox": sb.name, "path": e.path, "name": e.name, "ext": ext, "modified": e.modified }));
                }
            }
        }
        if out.len() > 800 {
            break;
        }
    }
    Ok(out)
}

/// Aperçu léger d'un fichier de la suite, pour l'intégration visuelle :
/// premières lignes d'une feuille, ou rendu HTML statique d'un document /
/// d'une présentation (celui qu'Opus enregistre à côté du modèle).
#[tauri::command]
pub fn living_file_preview(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    sandbox: String,
    path: String,
) -> Result<Value, String> {
    crate::session::require_unlocked(&app, session.inner())?;
    let id = if crate::sandbox::sandbox_list_unchecked(&app)?.iter().any(|m| m.id == sandbox) {
        sandbox.clone()
    } else {
        crate::sandbox::id_for_name(&app, &sandbox).ok_or("Sandbox introuvable")?
    };
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    if !OFFICE_EXT.contains(&ext.as_str()) {
        return Err("Type de fichier non intégrable".into());
    }
    if !crate::sandbox::exists_unchecked(&app, &id, &path) {
        return Err("Fichier introuvable".into());
    }
    let base = json!({ "sandboxId": id, "path": path, "ext": ext });
    match ext.as_str() {
        "lumensheet" => {
            let mut v = read_json_file(&app, &id, &path)?;
            let title = v.get("title").cloned().unwrap_or(json!(""));
            let sheets = v.pointer("/doc/sheets").and_then(|s| s.as_array()).cloned().unwrap_or_default();
            let names: Vec<Value> = sheets.iter().filter_map(|s| s.get("name").cloned()).collect();
            let first = names.first().and_then(|n| n.as_str()).unwrap_or("").to_string();
            let md = sheet_ref(&mut v, &first).map(|s| sheet_to_markdown(s)).unwrap_or_default();
            let mut out = base;
            out["kind"] = json!("sheet");
            out["title"] = title;
            out["sheets"] = json!(names);
            out["rows"] = json!(parse_table(&md).into_iter().take(9).map(|r| r.into_iter().take(7).collect::<Vec<_>>()).collect::<Vec<_>>());
            Ok(out)
        }
        "lumenpages" | "lumenkey" => {
            let v = read_json_file(&app, &id, &path)?;
            let mut out = base;
            out["kind"] = json!(if ext == "lumenkey" { "presentation" } else { "document" });
            out["title"] = v.get("title").cloned().unwrap_or(json!(""));
            out["pages"] = json!(v.pointer("/doc/pages").and_then(|p| p.as_array()).map(|a| a.len()).unwrap_or(0));
            out["html"] = json!(clip(v.get("html").and_then(|h| h.as_str()).unwrap_or(""), 400_000));
            Ok(out)
        }
        _ => {
            let mut out = base;
            out["kind"] = json!(match ext.as_str() { "pptx" => "presentation", "xlsx" => "sheet", _ => "document" });
            out["title"] = json!(path.rsplit('/').next().unwrap_or(&path));
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bloc_remplace_sans_toucher_au_reste() {
        let body = "Avant\n\n:::live lv1\nancien\n:::\n\nAprès";
        assert_eq!(replace_live(body, "lv1", "nouveau\ncontenu"), "Avant\n\n:::live lv1\nnouveau\ncontenu\n:::\n\nAprès");
        // Bloc absent : ajouté en fin de note.
        assert!(replace_live("Texte", "lv2", "x").ends_with(":::live lv2\nx\n:::\n"));
    }

    #[test]
    fn tableau_markdown_et_csv() {
        let md = "| Nom | Qté |\n|---|---:|\n| **Pommes** | 3 |";
        assert_eq!(parse_table(md), vec![vec!["Nom", "Qté"], vec!["Pommes", "3"]]);
        assert_eq!(parse_table("a;b\n1;2"), vec![vec!["a", "b"], vec!["1", "2"]]);
        assert_eq!(col_name(0), "A");
        assert_eq!(col_name(27), "AB");
    }

    #[test]
    fn html_brut_du_modele_neutralise() {
        let h = markdown_html("**gras** <script>alert(1)</script>");
        assert!(h.contains("<strong>gras</strong>"));
        assert!(!h.contains("<script>"));
    }

    #[test]
    fn emballage_retire() {
        assert_eq!(clean_output("```markdown\n# Titre\n```"), "# Titre");
        assert_eq!(clean_output("Voici le bloc :\n- a"), "- a");
    }
}

/// Réponse qui refuse au lieu d'écrire (petits modèles persuadés de devoir
/// passer par un outil pour toucher au document).
fn looks_like_refusal(out: &str) -> bool {
    let head: String = out.chars().take(200).collect::<String>().to_lowercase();
    ["je ne peux pas", "je n'ai pas accès", "je n’ai pas accès", "impossible d'accéder", "i cannot", "i can't", "i don't have access", "i do not have access"]
        .iter()
        .any(|p| head.contains(p))
}
