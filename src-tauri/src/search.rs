//! Recherche de CONTENU pour la barre d'action rapide (⌘K) du bureau.
//!
//! Ce module s'appelait `spotlight` — nom déposé par Apple, et qui ne dit rien
//! de ce qu'il fait. La commande exposée est `lumen_search`.
//!
//! Deux sources, toutes deux lues à la demande et bornées — pas d'index
//! persistant, pas de veilleur de fichiers, pas d'embeddings :
//!  - `app-state/*.json` : l'état des apps (notes, moodboard, podcast…). Les
//!    apps y rangent souvent des chaînes qui sont elles-mêmes du JSON
//!    (`notes.data` = tableau de notes) : on les redéplie.
//!  - les fichiers TEXTE des sandboxes (md, txt, csv, json, html, documents
//!    Lumen…), parcourus en largeur, profondeur et volume plafonnés.
//!
//! Budget : ~600 fichiers, 256 Ko par fichier, 24 Mo lus au total, 400 ms
//! de temps mur. Au-delà, on rend ce qu'on a — une recherche instantanée
//! partielle vaut mieux qu'une recherche complète qui fige le bureau.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::Manager;

const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_TOTAL_BYTES: u64 = 24 * 1024 * 1024;
const MAX_FILES: usize = 600;
const MAX_DEPTH: usize = 4;
const TIME_BUDGET: Duration = Duration::from_millis(400);
const SNIPPET_CHARS: usize = 90;

const TEXT_EXTS: &[&str] = &[
    "md", "txt", "markdown", "csv", "tsv", "json", "html", "htm", "xml", "yaml", "yml", "toml",
    "log", "js", "ts", "py", "rs", "css", "sh", "sql", "ini", "cfg",
    "lumenpages", "lumenkey", "lumensheet", "lumenmind", "lumenboard", "fluxo",
];

#[derive(Serialize, Clone)]
pub struct Hit {
    /// "state" (état d'une app) ou "file" (fichier de sandbox).
    pub kind: String,
    /// Nom de l'app (state) ou id de la sandbox (file).
    pub source: String,
    /// Nom lisible de la sandbox (file) — vide sinon.
    #[serde(default)]
    pub source_name: String,
    /// Titre de l'entrée (note, document…) ou nom de fichier.
    pub title: String,
    /// Chemin relatif dans la sandbox (file) — vide sinon.
    #[serde(default)]
    pub path: String,
    /// Id de l'entrée dans l'état de l'app, quand il existe (ouvre la note).
    #[serde(default)]
    pub id: String,
    /// Extrait autour de la première occurrence.
    pub snippet: String,
}

struct Budget {
    started: Instant,
    bytes: u64,
    files: usize,
}
impl Budget {
    fn exhausted(&self) -> bool {
        self.started.elapsed() > TIME_BUDGET || self.bytes > MAX_TOTAL_BYTES || self.files > MAX_FILES
    }
}

/// Extrait de `text` autour de la première occurrence de `needle` (déjà en
/// minuscules), sur frontières de caractères.
fn snippet(text: &str, needle: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let pos = lower.find(needle)?;
    // `to_lowercase` peut changer la longueur en octets : on se recale sur le
    // texte d'origine par comptage de caractères.
    let char_pos = lower[..pos].chars().count();
    let chars: Vec<char> = text.chars().collect();
    let start = char_pos.saturating_sub(SNIPPET_CHARS / 3);
    let end = (char_pos + needle.chars().count() + SNIPPET_CHARS).min(chars.len());
    let mut s: String = chars[start..end].iter().collect::<String>()
        .split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 { s.insert(0, '…'); }
    if end < chars.len() { s.push('…'); }
    Some(s)
}

fn first_str<'a>(obj: &'a serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| obj.get(*k).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()))
}

/// Parcourt un JSON en redépliant les chaînes qui sont elles-mêmes du JSON.
/// Chaque objet portant un titre ET une occurrence devient un résultat.
fn walk_json(v: &serde_json::Value, needle: &str, app: &str, hits: &mut Vec<Hit>, depth: usize, limit: usize) {
    if hits.len() >= limit || depth > 12 {
        return;
    }
    match v {
        serde_json::Value::Object(obj) => {
            let title = first_str(obj, &["title", "name", "label", "subject"]);
            let text_keys = ["body", "text", "content", "markdown", "description", "summary", "notes", "transcript"];
            let mut found: Option<String> = None;
            for k in text_keys {
                if let Some(s) = obj.get(k).and_then(|x| x.as_str()) {
                    if let Some(sn) = snippet(s, needle) { found = Some(sn); break; }
                }
            }
            if found.is_none() {
                if let Some(t) = title {
                    if t.to_lowercase().contains(needle) { found = Some(t.to_string()); }
                }
            }
            if let (Some(t), Some(sn)) = (title, found) {
                hits.push(Hit {
                    kind: "state".into(),
                    source: app.to_string(),
                    source_name: String::new(),
                    title: t.chars().take(120).collect(),
                    path: String::new(),
                    id: obj.get("id").map(|i| match i { serde_json::Value::String(s) => s.clone(), other => other.to_string() }).unwrap_or_default(),
                    snippet: sn,
                });
                // Un objet trouvé n'est pas redéplié : ses sous-objets
                // (blocs, paragraphes) dupliqueraient le résultat.
                return;
            }
            for (_, child) in obj {
                walk_json(child, needle, app, hits, depth + 1, limit);
            }
        }
        serde_json::Value::Array(arr) => {
            for child in arr {
                walk_json(child, needle, app, hits, depth + 1, limit);
            }
        }
        serde_json::Value::String(s) => {
            let t = s.trim_start();
            if (t.starts_with('{') || t.starts_with('[')) && s.len() < 8 * 1024 * 1024 {
                if let Ok(inner) = serde_json::from_str::<serde_json::Value>(s) {
                    walk_json(&inner, needle, app, hits, depth + 1, limit);
                }
            }
        }
        _ => {}
    }
}

fn search_app_states(app: &tauri::AppHandle, needle: &str, hits: &mut Vec<Hit>, budget: &mut Budget, limit: usize) {
    let Ok(dir) = crate::paths::shared_data_dir(app.path()).map(|d| d.join("app-state")) else { return; };
    let Ok(entries) = fs::read_dir(&dir) else { return; };
    for e in entries.flatten() {
        if budget.exhausted() || hits.len() >= limit { return; }
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") { continue; }
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        // Les états d'app peuvent être gros (moodboard illustré) : on lit
        // jusqu'à 8 Mo, mais pas un moodboard de 100 Mo d'images base64.
        if size > 8 * 1024 * 1024 { continue; }
        budget.bytes += size;
        budget.files += 1;
        let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let Ok(raw) = fs::read_to_string(&path) else { continue; };
        // Filtre grossier avant tout parsing : si la chaîne n'apparaît nulle
        // part (même échappée), inutile de désérialiser.
        if !raw.to_lowercase().contains(needle) { continue; }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            walk_json(&v, needle, &name, hits, 0, limit);
        }
    }
}

fn is_text_file(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .map(|e| TEXT_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Pour les documents Lumen (JSON), on ne cherche que dans les chaînes du
/// JSON — sans cela le mot cherché pourrait tomber sur un nom de clé.
fn file_snippet(path: &Path, raw: &str, needle: &str) -> Option<String> {
    let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    if matches!(ext.as_str(), "lumenpages" | "lumenkey" | "lumensheet" | "lumenmind" | "lumenboard" | "fluxo" | "json") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            let mut out = None;
            collect_string_hit(&v, needle, &mut out, 0);
            return out;
        }
    }
    snippet(raw, needle)
}

fn collect_string_hit(v: &serde_json::Value, needle: &str, out: &mut Option<String>, depth: usize) {
    if out.is_some() || depth > 16 { return; }
    match v {
        serde_json::Value::String(s) => { *out = snippet(s, needle); }
        serde_json::Value::Array(a) => for x in a { collect_string_hit(x, needle, out, depth + 1); },
        serde_json::Value::Object(o) => for (_, x) in o { collect_string_hit(x, needle, out, depth + 1); },
        _ => {}
    }
}

fn search_sandboxes(app: &tauri::AppHandle, needle: &str, hits: &mut Vec<Hit>, budget: &mut Budget, limit: usize) {
    let Ok(list) = crate::sandbox::sandbox_list_unchecked(app) else { return; };
    for sb in list {
        let Ok(root) = crate::sandbox::sandbox_root(app, &sb.id) else { continue; };
        let mut level: Vec<PathBuf> = vec![root.clone()];
        let mut depth = 0;
        while !level.is_empty() && depth < MAX_DEPTH {
            let mut next = Vec::new();
            for dir in level.drain(..) {
                let Ok(entries) = fs::read_dir(&dir) else { continue; };
                for e in entries.flatten() {
                    if budget.exhausted() || hits.len() >= limit { return; }
                    let path = e.path();
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') || name == "node_modules" { continue; }
                    let Ok(meta) = e.metadata() else { continue; };
                    if meta.is_dir() { next.push(path); continue; }
                    if !is_text_file(&path) || meta.len() > MAX_FILE_BYTES { continue; }
                    budget.files += 1;
                    budget.bytes += meta.len();
                    let Ok(raw) = fs::read_to_string(&path) else { continue; };
                    let rel = path.strip_prefix(&root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                    let title_hit = name.to_lowercase().contains(needle);
                    let sn = file_snippet(&path, &raw, needle).or_else(|| title_hit.then(|| name.clone()));
                    if let Some(sn) = sn {
                        hits.push(Hit {
                            kind: "file".into(),
                            source: sb.id.clone(),
                            source_name: sb.name.clone(),
                            title: name.clone(),
                            path: rel,
                            id: String::new(),
                            snippet: sn,
                        });
                    }
                }
            }
            level = next;
            depth += 1;
        }
    }
}

/// Sources de données de Lumen qui ne vivent NI dans `app-state/`, NI dans une
/// sandbox : elles ont chacune leur fichier à la racine des données partagées.
/// Sans cette table, chercher le nom d'un correspondant ou l'objet d'un rappel
/// ne donnait rien — alors que ce sont des recherches évidentes.
///
/// Chaque entrée : (fichier, `kind` renvoyé au front, clé du titre, clés de corps).
/// Le `kind` sert au front à ouvrir la bonne app (cf. openSearchHit).
const DATA_SOURCES: &[(&str, &str, &str, &[&str])] = &[
    ("inbox.json", "inbox", "subject", &["body", "from"]),
    ("reminders.json", "reminder", "title", &["note"]),
    ("mail.json", "mail", "subject", &["body", "from", "to"]),
    ("contacts.json", "contact", "name", &["email", "phone", "company", "role", "note"]),
];

fn search_data_files(app: &tauri::AppHandle, needle: &str, hits: &mut Vec<Hit>, budget: &mut Budget, limit: usize) {
    let Ok(dir) = crate::paths::shared_data_dir(app.path()) else { return; };
    for (file, kind, title_key, body_keys) in DATA_SOURCES {
        if budget.exhausted() || hits.len() >= limit { return; }
        let path = dir.join(file);
        let Ok(meta) = fs::metadata(&path) else { continue; };
        if meta.len() > 8 * 1024 * 1024 { continue; }
        budget.files += 1;
        budget.bytes += meta.len();
        let Ok(raw) = fs::read_to_string(&path) else { continue; };
        if !raw.to_lowercase().contains(needle) { continue; }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else { continue; };
        // Les quatre fichiers sont des tableaux d'objets plats ; un objet
        // enveloppe (`{ items: [...] }`) est accepté pour rester tolérant.
        let items = match &value {
            serde_json::Value::Array(a) => a.clone(),
            serde_json::Value::Object(o) => o.values()
                .find_map(|v| v.as_array().cloned())
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        for item in items {
            if budget.exhausted() || hits.len() >= limit { return; }
            let Some(obj) = item.as_object() else { continue; };
            let title = obj.get(*title_key).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mut sn = snippet(&title, needle);
            if sn.is_none() {
                for k in *body_keys {
                    if let Some(text) = obj.get(*k).and_then(|v| v.as_str()) {
                        if let Some(found) = snippet(text, needle) { sn = Some(found); break; }
                    }
                }
            }
            let Some(sn) = sn else { continue; };
            hits.push(Hit {
                kind: (*kind).into(),
                source: (*kind).into(),
                source_name: String::new(),
                title: if title.is_empty() { sn.chars().take(60).collect() } else { title.chars().take(120).collect() },
                path: String::new(),
                id: obj.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                snippet: sn,
            });
        }
    }
}

/// Recherche de contenu : états d'apps puis sandboxes, sous budget.
#[tauri::command]
pub async fn lumen_search(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Hit>, String> {
    crate::session::require_unlocked(&app, session.inner())?;
    let needle = query.trim().to_lowercase();
    if needle.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(12).clamp(1, 50);
    tauri::async_runtime::spawn_blocking(move || {
        let mut hits = Vec::new();
        let mut budget = Budget { started: Instant::now(), bytes: 0, files: 0 };
        search_app_states(&app, &needle, &mut hits, &mut budget, limit);
        // Avant les sandboxes : un message ou un contact se trouve d'un coup,
        // là où le parcours des fichiers peut consommer tout le budget.
        search_data_files(&app, &needle, &mut hits, &mut budget, limit);
        search_sandboxes(&app, &needle, &mut hits, &mut budget, limit);
        hits.truncate(limit);
        hits
    })
    .await
    .map_err(|e| format!("Recherche interrompue : {e}"))
}

// ---------------------------------------------------------------------------
// Recherche pour l'IA (outils `sandbox_search` / `search_personal_data`).
//
// La recherche globale cherche la phrase tapée telle quelle : parfait pour la
// barre ⌘K, inutile pour une question en langage naturel. Ici la requête est
// découpée en mots, chaque fichier est noté selon les mots trouvés (le nom
// compte double), et la recherche est BORNÉE aux sandboxes que l'utilisateur a
// autorisées — le front ne passe que celles-là.
// ---------------------------------------------------------------------------

const AI_TIME_BUDGET: Duration = Duration::from_millis(2500);
const AI_MAX_FILES: usize = 2500;
const AI_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Documents binaires lisibles par `sandbox_read_file` (extraction de texte) :
/// trouvés par leur NOM, pour que l'IA puisse ensuite les ouvrir.
const DOC_EXTS: &[&str] = &["pdf", "docx", "doc", "odt", "xlsx", "xls", "ods", "pptx", "odp", "rtf", "epub"];
const STOPWORDS: &[&str] = &[
    "les", "des", "une", "dans", "pour", "avec", "sur", "que", "qui", "est", "sont", "mes", "mon", "ma", "ton", "tes",
    "quel", "quelle", "quels", "quelles", "fichier", "fichiers", "document", "documents", "sandbox", "sandboxes", "trouve",
    "cherche", "recherche", "the", "and", "for", "with", "my", "file", "files", "find", "search", "what", "where",
];

#[derive(Serialize, Clone)]
pub struct ScoredHit {
    #[serde(flatten)]
    pub hit: Hit,
    pub score: u32,
    pub matched: Vec<String>,
}

fn ai_terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in query.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
        if w.chars().count() < 3 || STOPWORDS.contains(&w) || out.iter().any(|x| x == w) { continue; }
        out.push(w.to_string());
        if out.len() >= 8 { break; }
    }
    out
}

fn scan_sandboxes_terms(app: &tauri::AppHandle, only: &[String], terms: &[String], out: &mut Vec<ScoredHit>) {
    let Ok(list) = crate::sandbox::sandbox_list_unchecked(app) else { return; };
    let started = Instant::now();
    let (mut files, mut bytes) = (0usize, 0u64);
    // Documents (PDF, Word…) dont on extrait le texte pour chercher DEDANS :
    // bornés en nombre et en taille, l'extraction coûte ~0,1 s par fichier.
    let mut extracted = 0usize;
    for sb in list {
        if !only.is_empty() && !only.iter().any(|id| id == &sb.id) { continue; }
        let Ok(root) = crate::sandbox::sandbox_root(app, &sb.id) else { continue; };
        let mut level: Vec<PathBuf> = vec![root.clone()];
        let mut depth = 0;
        while !level.is_empty() && depth < MAX_DEPTH + 2 {
            let mut next = Vec::new();
            for dir in level.drain(..) {
                let Ok(entries) = fs::read_dir(&dir) else { continue; };
                for e in entries.flatten() {
                    if started.elapsed() > AI_TIME_BUDGET || files > AI_MAX_FILES || bytes > AI_MAX_BYTES { return; }
                    let path = e.path();
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') || name == "node_modules" { continue; }
                    let Ok(meta) = e.metadata() else { continue; };
                    if meta.is_dir() { next.push(path); continue; }
                    files += 1;
                    let lname = name.to_lowercase();
                    let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
                    let mut score = 0u32;
                    let mut matched = Vec::new();
                    let mut snippet_text: Option<String> = None;
                    let is_doc = crate::rag::RICH_DOC_EXTS.contains(&ext.as_str());
                    let raw = if is_text_file(&path) && meta.len() <= MAX_FILE_BYTES {
                        bytes += meta.len();
                        fs::read_to_string(&path).ok()
                    } else if is_doc && meta.len() <= 4 * 1024 * 1024 && extracted < 20 && started.elapsed() < AI_TIME_BUDGET {
                        extracted += 1;
                        fs::read(&path).ok().and_then(|b| crate::rag::extract_document_text(&name, &b).ok())
                    } else { None };
                    let lraw = raw.as_ref().map(|r| r.to_lowercase());
                    for t in terms {
                        let in_name = lname.contains(t.as_str());
                        let in_body = lraw.as_ref().map(|r| r.contains(t.as_str())).unwrap_or(false);
                        if in_name { score += 2; }
                        if in_body {
                            score += 1;
                            if snippet_text.is_none() {
                                snippet_text = raw.as_ref().and_then(|r| file_snippet(&path, r, t));
                            }
                        }
                        if in_name || in_body { matched.push(t.clone()); }
                    }
                    if score == 0 { continue; }
                    if raw.is_none() && !DOC_EXTS.contains(&ext.as_str()) && !is_text_file(&path) { continue; }
                    // Extrait d'un document : le snippet « fichier » ne sait pas le découper.
                    if is_doc && snippet_text.is_none() {
                        if let (Some(r), Some(t)) = (raw.as_ref(), matched.iter().find(|t| lraw.as_ref().map(|l| l.contains(t.as_str())).unwrap_or(false))) {
                            snippet_text = snippet(r, t);
                        }
                    }
                    let rel = path.strip_prefix(&root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                    out.push(ScoredHit {
                        hit: Hit {
                            kind: "file".into(),
                            source: sb.id.clone(),
                            source_name: sb.name.clone(),
                            title: name.clone(),
                            path: rel,
                            id: String::new(),
                            snippet: snippet_text.unwrap_or_else(|| if raw.is_none() { format!("document {ext} (contenu lisible avec sandbox_read)") } else { name.clone() }),
                        },
                        score,
                        matched,
                    });
                }
            }
            level = next;
            depth += 1;
        }
    }
}

/// Recherche multi-mots, notée, bornée aux sandboxes autorisées (`sandbox_ids`,
/// vide = aucune) et, sur demande, aux données personnelles (courrier,
/// contacts, rappels, messagerie des agents).
#[tauri::command]
pub async fn data_search(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    query: String,
    sandbox_ids: Option<Vec<String>>,
    include_data: Option<bool>,
    limit: Option<usize>,
) -> Result<Vec<ScoredHit>, String> {
    crate::session::require_unlocked(&app, session.inner())?;
    let terms = ai_terms(&query);
    if terms.is_empty() { return Ok(Vec::new()); }
    let limit = limit.unwrap_or(12).clamp(1, 40);
    let ids = sandbox_ids.unwrap_or_default();
    let with_data = include_data.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<ScoredHit> = Vec::new();
        if with_data {
            // Les sources de données : un passage par mot, fusion par entrée.
            for t in &terms {
                let mut hits = Vec::new();
                let mut budget = Budget { started: Instant::now(), bytes: 0, files: 0 };
                search_data_files(&app, t, &mut hits, &mut budget, 40);
                // États des apps (Kanban, agenda, Notes…) : même parcours que ⌘K.
                search_app_states(&app, t, &mut hits, &mut budget, 40);
                for h in hits {
                    if let Some(prev) = out.iter_mut().find(|x| x.hit.kind == h.kind && x.hit.id == h.id && x.hit.title == h.title) {
                        prev.score += 1;
                        prev.matched.push(t.clone());
                    } else {
                        out.push(ScoredHit { hit: h, score: 1, matched: vec![t.clone()] });
                    }
                }
            }
        }
        if !ids.is_empty() {
            scan_sandboxes_terms(&app, &ids, &terms, &mut out);
        }
        out.sort_by(|a, b| b.score.cmp(&a.score));
        out.truncate(limit);
        out
    })
    .await
    .map_err(|e| format!("Recherche interrompue : {e}"))
}

#[cfg(test)]
mod ai_search_tests {
    use super::*;
    #[test]
    fn termes_sans_mots_vides() {
        assert_eq!(ai_terms("Trouve dans mes fichiers le devis de la cuisine 2026"), vec!["devis", "cuisine", "2026"]);
    }
}
