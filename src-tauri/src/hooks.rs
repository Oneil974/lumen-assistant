//! Agents de code EXTERNES dans la capsule Halo.
//!
//! Claude Code (et tout outil capable d'appeler une commande à chaque étape :
//! Cursor, Codex, Gemini CLI…) envoie ses évènements de hook à
//! `POST http://127.0.0.1:8765/hook/agent?source=claude-code`, corps = le JSON
//! que l'outil passe à son hook sur l'entrée standard. On en fait les mêmes
//! évènements que les agents Lumen (`agent-running`, `agent-step`,
//! `agent-progress`) : la capsule les affiche sans savoir d'où ils viennent,
//! avec en plus les lignes modifiées (+N −M) des fichiers édités.
//!
//! Rien ne sort de la machine : le serveur écoute en boucle locale, et la
//! commande installée est un simple `curl` qui ne bloque jamais l'outil
//! (délai de 2 s, erreurs ignorées).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::Emitter;

#[derive(Default)]
struct Session {
    task: String,
    files: HashSet<String>,
    plus: usize,
    minus: usize,
    steps: usize,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static S: std::sync::OnceLock<Mutex<HashMap<String, Session>>> = std::sync::OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn source_label(source: &str) -> &'static str {
    match source {
        "cursor" => "Cursor",
        "codex" => "Codex",
        "gemini" => "Gemini CLI",
        _ => "Claude Code",
    }
}

fn lines(s: Option<&serde_json::Value>) -> usize {
    s.and_then(|v| v.as_str()).map(|t| if t.is_empty() { 0 } else { t.lines().count().max(1) }).unwrap_or(0)
}

/// Lignes ajoutées / retirées par un appel d'édition (Edit, MultiEdit, Write).
fn diff_of(tool: &str, input: &serde_json::Value) -> Option<(usize, usize)> {
    match tool {
        "Edit" => Some((lines(input.get("new_string")), lines(input.get("old_string")))),
        "Write" => Some((lines(input.get("content")), 0)),
        "MultiEdit" => {
            let edits = input.get("edits")?.as_array()?;
            Some(edits.iter().fold((0, 0), |(p, m), e| (p + lines(e.get("new_string")), m + lines(e.get("old_string")))))
        }
        _ => None,
    }
}

fn short(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n { format!("{t}…") } else { t }
}

/// Aperçu lisible d'un appel d'outil (fichier, commande, motif…).
fn tool_hint(input: &serde_json::Value) -> String {
    for k in ["file_path", "command", "pattern", "url", "query", "description", "prompt"] {
        if let Some(v) = input.get(k).and_then(|v| v.as_str()) {
            let v = if k == "file_path" { v.rsplit('/').next().unwrap_or(v) } else { v };
            return short(v, 80);
        }
    }
    String::new()
}

/// Traite un évènement de hook. Ne renvoie rien : un hook ne doit jamais
/// faire échouer l'outil qui l'appelle.
pub fn handle(app: &tauri::AppHandle, source: &str, p: &serde_json::Value) {
    let session = p.get("session_id").and_then(|v| v.as_str()).unwrap_or("default");
    let id = format!("ext:{}:{}", source, short(session, 8).trim_end_matches('…'));
    let project = p.get("cwd").and_then(|v| v.as_str()).and_then(|c| c.rsplit('/').next()).unwrap_or("");
    let name = if project.is_empty() { source_label(source).to_string() } else { format!("{} · {}", source_label(source), project) };
    let event = p.get("hook_event_name").and_then(|v| v.as_str()).unwrap_or("");
    let ts = now_secs();

    match event {
        "SessionStart" | "UserPromptSubmit" => {
            let prompt = p.get("prompt").and_then(|v| v.as_str()).map(|s| short(s.trim(), 120)).unwrap_or_default();
            if let Ok(mut m) = sessions().lock() {
                let s = m.entry(id.clone()).or_default();
                if event == "UserPromptSubmit" {
                    *s = Session { task: prompt.clone(), ..Default::default() };
                }
            }
            if event == "UserPromptSubmit" {
                crate::agents::ext_mark_running(&id, &name, &prompt);
                crate::ensure_capsule(app);
                let _ = app.emit("agent-running", serde_json::json!({ "active": true, "agent_id": id, "task": prompt, "agent": name }));
            }
        }
        "PreToolUse" | "PostToolUse" => {
            let tool = p.get("tool_name").and_then(|v| v.as_str()).unwrap_or("outil");
            let input = p.get("tool_input").cloned().unwrap_or(serde_json::Value::Null);
            let mut extra = String::new();
            let task = sessions().lock().ok().and_then(|m| m.get(&id).map(|s| s.task.clone())).unwrap_or_default();
            crate::agents::ext_mark_running(&id, &name, &task);
            if event == "PostToolUse" {
                if let Some((plus, minus)) = diff_of(tool, &input) {
                    extra = format!("+{plus} −{minus}");
                    if let Ok(mut m) = sessions().lock() {
                        let s = m.entry(id.clone()).or_default();
                        s.plus += plus;
                        s.minus += minus;
                        if let Some(f) = input.get("file_path").and_then(|v| v.as_str()) {
                            s.files.insert(f.to_string());
                        }
                    }
                }
                if let Ok(mut m) = sessions().lock() {
                    m.entry(id.clone()).or_default().steps += 1;
                }
            }
            crate::ensure_capsule(app);
            let hint = tool_hint(&input);
            let step = serde_json::json!({
                "agent_id": id,
                "agent": name,
                "kind": "tool",
                "skill": tool,
                "input": if extra.is_empty() { hint } else { format!("{hint} {extra}") },
                "done": event == "PostToolUse",
                "success": true,
                "ts": ts,
            });
            let _ = app.emit("agent-step", step);
        }
        "Notification" => {
            // Claude Code attend une permission ou une réponse : on le dit
            // dans la capsule (la décision se prend dans le terminal).
            let msg = p.get("message").and_then(|v| v.as_str()).unwrap_or("En attente de ta réponse");
            crate::push_notification(app, serde_json::json!({
                "kind": "warning", "icon": "terminal", "title": name, "body": msg, "source": "agent-hook",
            }));
        }
        "Stop" | "SessionEnd" => {
            let s = sessions().lock().ok().and_then(|mut m| m.remove(&id));
            let Some(s) = s else {
                crate::agents::ext_clear_running(&id);
                return;
            };
            crate::agents::ext_clear_running(&id);
            let _ = app.emit("agent-running", serde_json::json!({ "active": false, "agent_id": id }));
            let report = if s.files.is_empty() {
                format!("{} étape(s)", s.steps)
            } else {
                format!("{} fichier(s) modifié(s) · +{} −{} · {} étape(s)", s.files.len(), s.plus, s.minus, s.steps)
            };
            let _ = app.emit("agent-progress", serde_json::json!({
                "agent_id": id, "agent": name, "task": s.task, "output": report, "success": true, "ts": ts,
            }));
            crate::notify_capsule(app, serde_json::json!({
                "kind": "success", "icon": "terminal", "title": format!("{name} — terminé"),
                "body": if s.task.is_empty() { report } else { format!("{} — {}", s.task, report) },
                "source": "agent-hook",
            }), false);
        }
        _ => {}
    }
}

const HOOK_EVENTS: [&str; 6] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"];

fn hook_command(source: &str) -> String {
    format!(
        "curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- 'http://127.0.0.1:{}/hook/agent?source={}' >/dev/null 2>&1 || true",
        crate::companion::LOCAL_PORT,
        source
    )
}

/// Installe (ou complète) les hooks de Claude Code dans ~/.claude/settings.json.
/// Une copie de sauvegarde est faite avant toute écriture ; les hooks déjà
/// présents de l'utilisateur sont conservés, et une seconde installation ne
/// duplique rien.
#[tauri::command]
pub fn agent_hook_install(target: String) -> Result<String, String> {
    if target != "claude-code" {
        return Err(format!("cible inconnue : {target}"));
    }
    let home = std::env::var("HOME").map_err(|_| "dossier personnel introuvable".to_string())?;
    let dir = std::path::Path::new(&home).join(".claude");
    let path = dir.join("settings.json");
    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(txt) => {
            let _ = std::fs::write(dir.join("settings.json.lumen-backup"), &txt);
            serde_json::from_str(&txt).map_err(|e| format!("settings.json illisible ({e}) : rien n'a été modifié"))?
        }
        Err(_) => serde_json::json!({}),
    };
    let obj = root.as_object_mut().ok_or("settings.json n'est pas un objet JSON")?;
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    let hooks = hooks.as_object_mut().ok_or("« hooks » n'est pas un objet")?;
    let cmd = hook_command("claude-code");
    let mut added = 0;
    for ev in HOOK_EVENTS {
        let list = hooks.entry(ev).or_insert_with(|| serde_json::json!([]));
        let Some(arr) = list.as_array_mut() else { continue };
        let present = arr.iter().any(|m| {
            m.get("hooks").and_then(|h| h.as_array()).map_or(false, |h| {
                h.iter().any(|x| x.get("command").and_then(|c| c.as_str()).map_or(false, |c| c.contains("/hook/agent")))
            })
        });
        if !present {
            arr.push(serde_json::json!({ "matcher": "", "hooks": [{ "type": "command", "command": cmd }] }));
            added += 1;
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let txt = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| e.to_string())?;
    Ok(if added == 0 {
        "Déjà installé : les sessions Claude Code apparaissent dans la capsule.".into()
    } else {
        format!("Installé ({added} évènements) dans ~/.claude/settings.json (sauvegarde : settings.json.lumen-backup). Les nouvelles sessions Claude Code apparaîtront dans la capsule.")
    })
}
