//! Réglages du RITUEL DU MATIN (Lumen XR) : ville de la météo, thèmes
//! d'actualité suivis, objectif de chaque projet. Rangés dans
//! `<données partagées>/morning.json`, modifiables depuis les Réglages, par le
//! script `scripts/seed-morning.mjs` et par les agents (outil `morning_configure`).

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("morning.json"))
}

pub fn load(app: &tauri::AppHandle) -> Value {
    let v: Value = path(app).ok().and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    if v.is_object() { v } else { json!({ "city": "", "topics": [], "projects": {} }) }
}

fn save(app: &tauri::AppHandle, v: &Value) -> Result<(), String> {
    fs::write(path(app)?, serde_json::to_string_pretty(v).unwrap_or_default()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn morning_config_get(app: tauri::AppHandle) -> Value {
    load(&app)
}

#[tauri::command]
pub fn morning_config_set(app: tauri::AppHandle, config: Value) -> Result<(), String> {
    if !config.is_object() { return Err("configuration invalide".into()); }
    save(&app, &config)
}

/// Fusionne une modification partielle (outil des agents) et rend un résumé.
/// `topics` remplace la liste, `add_topic` / `remove_topic` la retouchent,
/// `project` + `goal` fixent l'objectif d'un projet.
pub fn configure(app: &tauri::AppHandle, args: &Value) -> Result<String, String> {
    let mut v = load(app);
    let mut done = vec![];
    if let Some(c) = args["city"].as_str().filter(|s| !s.trim().is_empty()) {
        v["city"] = json!(c.trim());
        done.push(format!("ville météo : {}", c.trim()));
    }
    if !v["topics"].is_array() { v["topics"] = json!([]); }
    if let Some(list) = args["topics"].as_array() {
        v["topics"] = json!(list.iter().filter_map(|t| t.as_str()).map(|t| t.trim()).filter(|t| !t.is_empty()).take(8).collect::<Vec<_>>());
        done.push("thèmes d'actualité remplacés".into());
    }
    if let Some(t) = args["add_topic"].as_str().filter(|s| !s.trim().is_empty()) {
        let topics = v["topics"].as_array_mut().unwrap();
        if !topics.iter().any(|x| x.as_str().map(|s| s.eq_ignore_ascii_case(t.trim())).unwrap_or(false)) { topics.push(json!(t.trim())); }
        done.push(format!("thème ajouté : {}", t.trim()));
    }
    if let Some(t) = args["remove_topic"].as_str() {
        v["topics"].as_array_mut().unwrap().retain(|x| !x.as_str().map(|s| s.eq_ignore_ascii_case(t.trim())).unwrap_or(false));
        done.push(format!("thème retiré : {}", t.trim()));
    }
    if let (Some(p), Some(g)) = (args["project"].as_str().filter(|s| !s.trim().is_empty()), args["goal"].as_str()) {
        if !v["projects"].is_object() { v["projects"] = json!({}); }
        v["projects"][p.trim()] = json!({ "goal": g.trim() });
        done.push(format!("objectif de « {} » fixé", p.trim()));
    }
    if done.is_empty() { return Err("rien à changer : donne city, topics, add_topic, remove_topic ou project + goal".into()); }
    save(app, &v)?;
    Ok(done.join(" ; "))
}

/// Données du rituel en UN appel : météo de la ville, deux titres par thème,
/// avancement des projets (cartes Kanban étiquetées, part dans « Fait »),
/// évènements des 7 prochains jours. Ce qui échoue (réseau…) reste vide.
#[tauri::command]
pub async fn morning_brief(app: tauri::AppHandle) -> Value {
    let cfg = load(&app);
    let en = crate::agents::read_llm_config(&app).language == "en";
    let city = cfg["city"].as_str().unwrap_or("").to_string();
    let weather = crate::live_data::weather_data(&city, en).await.unwrap_or(Value::Null);
    let _ = &cfg;
    let news: Vec<Value> = news_for_topics(&app, en, 2).await.into_iter().take(5).collect();
    let dir = crate::paths::shared_data_dir(app.path()).ok();
    let read = |name: &str| -> Value {
        dir.as_ref().and_then(|d| fs::read_to_string(d.join(name)).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
    };
    // Projets : étiquettes des cartes ; « fait » = colonne dont le titre dit fait/terminé/done.
    let board = read("kanban.json");
    let cols: Vec<(String, String)> = board["columns"].as_array().cloned().unwrap_or_default().iter()
        .map(|c| (c["id"].as_str().unwrap_or("").to_string(), c["title"].as_str().unwrap_or("").to_lowercase())).collect();
    let is_done = |col: &str| cols.iter().any(|(id, t)| id == col && (t.contains("fait") || t.contains("termin") || t.contains("done")));
    let mut projects: std::collections::BTreeMap<String, (usize, usize, Option<String>)> = Default::default();
    for c in board["cards"].as_array().cloned().unwrap_or_default() {
        let col = c["colId"].as_str().unwrap_or("");
        for l in c["labels"].as_array().cloned().unwrap_or_default().iter().filter_map(|l| l.as_str()) {
            if l == "seed-morning" { continue; }
            let e = projects.entry(l.to_string()).or_default();
            e.1 += 1;
            if is_done(col) { e.0 += 1 } else if e.2.is_none() { e.2 = c["title"].as_str().map(String::from) }
        }
    }
    // Les projets AVEC un objectif d'abord (ce sont ceux que l'utilisateur suit).
    let goals = cfg["projects"].clone();
    let mut list: Vec<Value> = projects.into_iter().map(|(name, (done, total, next))| json!({
        "name": name, "done": done, "total": total, "progress": if total > 0 { done as f64 / total as f64 } else { 0.0 },
        "next": next, "goal": goals[&name]["goal"].as_str().unwrap_or(""),
    })).collect();
    list.sort_by_key(|p| (p["goal"].as_str().unwrap_or("").is_empty(), -(p["total"].as_u64().unwrap_or(0) as i64)));
    list.truncate(4);
    // Agenda : rappels non faits des 7 prochains jours (évènements datés).
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let mut events: Vec<Value> = read("reminders.json").as_array().cloned().unwrap_or_default().into_iter()
        .filter(|r| !r["done"].as_bool().unwrap_or(false))
        .filter(|r| { let t = r["due_at"].as_i64().unwrap_or(0); t >= now - 3_600_000 && t <= now + 7 * 86_400_000 })
        .map(|r| json!({ "title": r["title"], "note": r["note"], "at": r["due_at"] }))
        .collect();
    events.sort_by_key(|e| e["at"].as_i64().unwrap_or(0));
    events.truncate(10);
    json!({ "city": city, "weather": weather, "news": news, "projects": list, "events": events, "now": now })
}


// ===== Actualités du matin =====
//
// Les thèmes sont choisis par l'utilisateur (app Matin, Réglages, ou un agent
// via `morning_configure`). La VEILLE elle-même est faite par l'agent
// « Veilleur web » : il lit les thèmes (`morning_topics`), cherche, recoupe et
// publie par thème quelques articles résumés (`morning_news_publish`), rangés
// dans `morning_news.json`. Le brief les préfère s'ils ont moins de 24 h ;
// sinon il retombe sur les titres de Google Actualités, pour que les cartes ne
// soient jamais vides faute d'agent.

fn news_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(path(app)?.with_file_name("morning_news.json"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn load_news(app: &tauri::AppHandle) -> Value {
    news_path(app).ok().and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok())
        .filter(|v: &Value| v.is_object()).unwrap_or_else(|| json!({ "topics": {} }))
}

/// Thèmes suivis, pour l'agent (et l'UI).
pub fn topics(app: &tauri::AppHandle) -> Vec<String> {
    load(app)["topics"].as_array().cloned().unwrap_or_default().iter().filter_map(|t| t.as_str().map(str::to_string)).collect()
}

/// Publication de l'agent : `topic` + `items` [{title, summary, source, url}].
pub fn publish_news(app: &tauri::AppHandle, args: &Value, author: &str) -> Result<String, String> {
    let topic = args["topic"].as_str().map(str::trim).filter(|t| !t.is_empty()).ok_or("topic requis")?.to_string();
    let items: Vec<Value> = args["items"].as_array().cloned().unwrap_or_default().into_iter().filter_map(|it| {
        let title = it["title"].as_str()?.trim().to_string();
        if title.is_empty() { return None; }
        let clip = |v: &Value, n: usize| v.as_str().map(|s| s.trim().chars().take(n).collect::<String>()).unwrap_or_default();
        Some(json!({
            "title": title.chars().take(160).collect::<String>(),
            "summary": clip(&it["summary"], 600),
            "source": clip(&it["source"], 80),
            "link": clip(&it["url"], 400),
        }))
    }).take(6).collect();
    if items.is_empty() { return Err("items vide : donne au moins un article (title, summary, source, url)".into()); }
    let mut v = load_news(app);
    if !v["topics"].is_object() { v["topics"] = json!({}); }
    let n = items.len();
    v["topics"][&topic] = json!({ "items": items, "at": now_ms(), "by": author });
    fs::write(news_path(app)?, serde_json::to_string_pretty(&v).unwrap_or_default()).map_err(|e| e.to_string())?;
    use tauri::Emitter;
    let _ = app.emit("morning-news", json!({ "topic": topic }));
    Ok(format!("{n} article(s) publiés pour « {topic} » dans le Matin."))
}

/// Actualités par thème : veille de l'agent si fraîche (< 24 h), sinon titres
/// récupérés en direct. `count` articles par thème.
pub async fn news_for_topics(app: &tauri::AppHandle, en: bool, count: usize) -> Vec<Value> {
    let published = load_news(app);
    let mut out = vec![];
    for t in topics(app).into_iter().take(8) {
        let p = &published["topics"][&t];
        let fresh = p["at"].as_i64().map(|at| now_ms() - at < 24 * 3_600_000).unwrap_or(false);
        if fresh && p["items"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            out.push(json!({ "topic": t, "items": p["items"], "by": p["by"], "at": p["at"], "curated": true }));
        } else {
            let items = crate::live_data::news_items(&t, en, count).await.unwrap_or_default();
            out.push(json!({ "topic": t, "items": items, "curated": false }));
        }
    }
    out
}

#[tauri::command]
pub async fn morning_news(app: tauri::AppHandle) -> Value {
    let en = crate::agents::read_llm_config(&app).language == "en";
    json!({ "topics": topics(&app), "news": news_for_topics(&app, en, 3).await })
}

/// Ajout / retrait d'un thème depuis l'app Matin.
#[tauri::command]
pub fn morning_topics_set(app: tauri::AppHandle, topics: Vec<String>) -> Result<Vec<String>, String> {
    let mut v = load(&app);
    let mut seen = std::collections::BTreeSet::new();
    let clean: Vec<String> = topics.into_iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty() && seen.insert(t.to_lowercase())).take(8).collect();
    v["topics"] = json!(clean);
    save(&app, &v)?;
    Ok(clean)
}
