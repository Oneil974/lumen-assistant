mod quick_prompt;
mod app_windows;
pub(crate) use app_windows::*;
// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod agents;
mod secrets;
mod hooks;
mod webview_media;
mod agent_runtime;
mod execution;
mod chat_runtime;
mod avatar_glb;
mod auth;
mod backup;
mod bonsai;
mod imageplayground;
mod companion;
mod contacts;
mod browser;
mod calendar_sync;
mod media;
mod doc_context;
mod domotique;
mod evolution;
mod facturx;
mod inbox;
mod hardware;
mod llama;
mod whisper;
mod rerank;
mod mcp_server;
mod litert;
mod applefm;
mod live_data;
mod mail;
mod manual;
mod mcp;
mod kanban;
mod morning;
mod license;
mod appperms;
mod appstore;
mod appserve;
mod llmlog;
mod llm_stream;
mod meet;
mod memory;
mod native_tools;
mod orb_bridge;
mod datasources;
mod dbshare;
mod netserver;
mod paths;
mod pi_deploy;
mod power;
mod pdf;
// Moteur PostgreSQL de DB Studio : la vraie implémentation n'est compilée qu'en
// édition Pro ; sinon une doublure qui refuse poliment (mêmes signatures, une
// seule liste de commandes à tenir).
#[cfg(feature = "pro")]
mod pro_db;
#[cfg(not(feature = "pro"))]
#[path = "pro_db_stub.rs"]
mod pro_db;
mod storage;
mod search;
mod profiler;
mod push;
mod apns;
mod devices;
mod autobackup;
mod report_subs;
mod vault;
mod vault_files;
mod datahub;
mod prompts;
mod rag;
mod recall;
mod rfid_store;
mod reminders;
mod sandbox;
mod screen;
mod serialflash;
mod session;
mod volume;
mod skills;
mod agent_skills;
mod tables;
mod telegram;
mod slack;
mod living;
mod assist;
mod messenger;
mod tts;
mod village_assets;
mod web_render;

use fluxo_engine::{
    Action as FluxoAction, ActionSpec as FluxoActionSpec, Engine, ExecContext as FluxoExecContext,
    ParamKind as FluxoParamKind, ParamSpec as FluxoParamSpec, RunResult as FluxoRunResult,
    Value as FluxoValue, Trigger as FluxoTrigger, Workflow as FluxoWorkflow,
};
use std::collections::BTreeMap;
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, Window};
use tokio::sync::Mutex;
use tokio_cron_scheduler::{Job, JobScheduler};

#[tauri::command]
fn close_window(window: Window) {
    // Le bouton ✕ ferme l'application entière. On quitte explicitement plutôt
    // que de seulement fermer la fenêtre principale : sinon, si la fenêtre de
    // notification flottante a déjà été créée (et reste masquée), l'app
    // continuerait de tourner en arrière-plan (dock + barre de menus).
    window.app_handle().exit(0);
}

#[tauri::command]
fn close_current_window(window: Window) {
    let _ = window.close();
}

#[tauri::command]
fn minimize_window(window: Window) {
    let _ = window.minimize();
}

/// Mode « application » de la fenêtre principale (cf. `set_shell_mode`) : la
/// barre ne doit plus redimensionner, déplacer, épingler ni rendre
/// transparente aux clics une fenêtre devenue une vraie fenêtre d'app.
static APP_SHELL: AtomicBool = AtomicBool::new(false);

fn app_shell_main(window: &Window) -> bool {
    window.label() == "main" && APP_SHELL.load(AtomicOrdering::SeqCst)
}

#[tauri::command]
fn set_always_on_top(window: Window, always_on_top: bool) {
    if app_shell_main(&window) {
        return;
    }
    let _ = window.set_always_on_top(always_on_top);
}

/// Bascule la fenêtre principale entre la barre flottante et le mode
/// application (fenêtre ombrée, redimensionnable, jamais au premier plan
/// forcé). Le contenu, lui, est réorganisé côté JS (lib/app-shell.js).
#[tauri::command]
fn set_shell_mode(window: Window, mode: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Réservé à la fenêtre principale".into());
    }
    if mode == "app" {
        APP_SHELL.store(true, AtomicOrdering::SeqCst);
        let _ = window.set_ignore_cursor_events(false);
        let _ = window.set_always_on_top(false);
        let _ = window.set_shadow(true);
        let _ = window.set_resizable(true);
        let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize { width: 860.0, height: 560.0 })));
        // 1280×840 au plus, sans dépasser 90 % de l'écran courant.
        let (mut w, mut h) = (1280.0_f64, 840.0_f64);
        if let Ok(Some(m)) = window.current_monitor() {
            let sz = m.size().to_logical::<f64>(m.scale_factor());
            w = w.min(sz.width * 0.9);
            h = h.min(sz.height * 0.88);
        }
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: w, height: h }));
        let _ = window.center();
    } else {
        APP_SHELL.store(false, AtomicOrdering::SeqCst);
        let _ = window.set_shadow(false);
        let _ = window.set_min_size(None::<tauri::Size>);
    }
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// Vue à ouvrir d'emblée en mode application (`LUMEN_APP_VIEW=messages`,
/// `notes`…) : postes scriptés et tests sans souris.
#[tauri::command]
fn shell_start_view() -> Option<String> {
    std::env::var("LUMEN_APP_VIEW").ok().filter(|v| !v.trim().is_empty())
}

#[tauri::command]
fn toggle_maximize(window: Window) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

/// Écran de choix du mode (barre / application / bureau) au lancement.
#[tauri::command]
fn open_mode_picker(app: tauri::AppHandle) -> Result<(), String> {
    // `LUMEN_SHELL=bar|app|desktop` impose le mode sans écran de choix
    // (postes préparés par script, tests automatisés).
    if let Ok(forced) = std::env::var("LUMEN_SHELL") {
        if ["bar", "app", "desktop"].contains(&forced.as_str()) {
            return apply_shell_choice(app, forced);
        }
    }
    run_window_task_after_ipc(&app, "launcher", |app| {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        if let Some(win) = app.get_webview_window("launcher") {
            let _ = win.show();
            let _ = win.set_focus();
            return Ok(());
        }
        let win = WebviewWindowBuilder::new(&app, "launcher", WebviewUrl::App("launcher/launcher.html".into()))
            .title("Lumen")
            .inner_size(1060.0, 700.0)
            .min_inner_size(760.0, 560.0)
            .resizable(true)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .center()
            .focused(true)
            .build()
            .map_err(|e| e.to_string())?;
        normalize_child_window(&win);
        // Lancé depuis un terminal (ou au retour du bureau), l'app n'est pas
        // forcément active : sans ceci l'écran de choix s'ouvre DERRIÈRE.
        let _ = win.set_focus();
        Ok(())
    })
}

/// Choix fait dans l'écran de lancement : bureau → Lumen Desktop (la barre
/// reste cachée) ; barre / application → la fenêtre principale s'applique le
/// mode (évènement `shell-mode`, géré par main.js) et se montre.
#[tauri::command]
fn apply_shell_choice(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    if let Some(l) = app.get_webview_window("launcher") {
        let _ = l.close();
    }
    if mode == "desktop" {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
        // main.js doit savoir qu'on est en mode bureau (à la fermeture du
        // bureau, il repropose le choix au lieu de rester invisible).
        let _ = app.emit_to("main", "shell-mode", serde_json::json!({ "mode": "desktop", "handled": true }));
        return open_sandbox_explorer(app, None, Some(true));
    }
    let _ = app.emit_to("main", "shell-mode", serde_json::json!({ "mode": mode }));
    Ok(())
}

#[tauri::command]
fn start_drag(window: Window) {
    let _ = window.start_dragging();
}

/// Active/désactive le « click-through » : quand `ignore` vaut `true`, la fenêtre
/// laisse passer la souris vers ce qu'il y a en dessous (bureau, autres apps).
/// Le frontend l'active dès que le curseur survole une zone transparente (vide).
#[tauri::command]
fn set_ignore_cursor_events(window: Window, ignore: bool) {
    // Linux : tao fait `gdk_window().unwrap()` pour ignore=true ; sur une fenêtre
    // cachée (pas encore réalisée par GTK, cas de la fenêtre main en 0.3) c'est
    // None → panique dans la boucle GTK et crash au lancement (vu sur Pi).
    #[cfg(target_os = "linux")]
    if ignore && !window.is_visible().unwrap_or(false) {
        return;
    }
    let _ = window.set_ignore_cursor_events(ignore && !app_shell_main(&window));
}

/// Position absolue du curseur à l'écran (coordonnées logiques). Sert au
/// déplacement manuel de la fenêtre, qui n'est pas contraint par la barre de
/// menus macOS (contrairement au drag natif `start_dragging`).
#[tauri::command]
fn cursor_pos_global(window: Window) -> Result<(f64, f64), String> {
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    Ok((cursor.x / scale, cursor.y / scale))
}

/// Place la fenêtre à une position logique donnée. Non contraint à l'écran :
/// permet de remonter la barre tout en haut, sous (voire au niveau de) la barre
/// de menus.
#[tauri::command]
fn set_window_position(window: Window, x: f64, y: f64) {
    if app_shell_main(&window) {
        return;
    }
    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
}

/// Position du curseur exprimée en coordonnées logiques relatives au coin haut-
/// gauche de la fenêtre (donc comparable aux coordonnées DOM côté frontend).
/// Indispensable au click-through : tant que la fenêtre ignore la souris, le
/// webview ne reçoit plus aucun évènement, donc on interroge la position native.
#[tauri::command]
fn cursor_pos_in_window(window: Window) -> Result<(f64, f64), String> {
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let x = (cursor.x - pos.x as f64) / scale;
    let y = (cursor.y - pos.y as f64) / scale;
    Ok((x, y))
}

#[tauri::command]
fn resize_window(window: Window, width: f64, height: f64) {
    if app_shell_main(&window) {
        return;
    }
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
}

#[tauri::command]
fn frontend_log(app: tauri::AppHandle, level: String, message: String) {
    eprintln!("[frontend:{level}] {message}");
    // Trace aussi dans window-diagnostics.log : en app installée, stderr est
    // perdu — le fichier permet de diagnostiquer après coup.
    diag_file_log(&app, &format!("frontend:{level}"), &message);
}

/// Réponse de la WebView à une demande d'embedding du backend (`POST /ml/embed`
/// du serveur loopback → évènement `ml-embed-request` → cette commande).
#[tauri::command]
fn ml_embed_result(id: u64, embedding: Option<Vec<f64>>, error: Option<String>) {
    companion::resolve_embed(
        id,
        match embedding {
            Some(v) => Ok(v),
            None => Err(error.unwrap_or_else(|| "embedding indisponible".into())),
        },
    );
}

/// Réponse du bureau à une demande d'export de rapport (`POST /reporting/export`
/// → évènement `reporting-export-request` → cette commande).
#[tauri::command]
fn reporting_export_result(id: u64, result: Option<serde_json::Value>, error: Option<String>) {
    companion::resolve_report_export(
        id,
        match result {
            Some(v) => Ok(v),
            None => Err(error.unwrap_or_else(|| "export indisponible".into())),
        },
    );
}

fn diag_file_log(app: &tauri::AppHandle, label: &str, message: &str) {
    let Ok(dir) = crate::paths::shared_data_dir(app.path()) else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("window-diagnostics.log");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        use std::io::Write;
        let _ = writeln!(file, "[{ts}] [{label}] {message}");
    }
}

fn attach_webview_diagnostics(win: &tauri::WebviewWindow, label: &'static str) {
    let win = win.clone();
    diag_file_log(win.app_handle(), label, "diagnostics scheduled");
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        let script = format!(
            r#"(async () => {{
  const report = {{
    label: "{label}",
    href: location.href,
    readyState: document.readyState,
    title: document.title,
    body: !!document.body,
    bodyTextLength: document.body ? document.body.innerText.length : -1,
    elementCount: document.querySelectorAll("*").length,
    scripts: Array.from(document.scripts).map(s => s.src || s.getAttribute("src") || "[inline]"),
    styles: Array.from(document.styleSheets).map(s => s.href || "[inline]").slice(0, 20),
    resources: performance.getEntriesByType("resource").map(r => {{
      return {{ name: r.name, type: r.initiatorType, duration: Math.round(r.duration) }};
    }}).slice(-40),
  }};
  async function probe(path) {{
    try {{
      const r = await fetch(path, {{ cache: "no-store" }});
      return {{ path, ok: r.ok, status: r.status, type: r.headers.get("content-type") || "" }};
    }} catch (e) {{
      return {{ path, ok: false, error: String(e && (e.stack || e.message) || e) }};
    }}
  }}
  report.fetches = await Promise.all([probe(location.href), probe("styles.css"), probe("main.js")]);
  try {{
    await window.__TAURI__?.core?.invoke?.("frontend_log", {{
      level: "diag",
      message: JSON.stringify(report)
    }});
  }} catch (e) {{
    console.error("frontend_log invoke failed", e, report);
  }}
}})();"#
        );
        if let Err(err) = win.eval(&script) {
            eprintln!("[webview-diag:{label}] eval failed: {err}");
            diag_file_log(win.app_handle(), label, &format!("eval failed: {err}"));
        } else {
            eprintln!("[webview-diag:{label}] eval injected");
            diag_file_log(win.app_handle(), label, "eval injected");
        }
    });
}

fn normalize_child_window(win: &tauri::WebviewWindow) {
    if cfg!(windows) {
        diag_file_log(win.app_handle(), win.label(), "normalize_child_window");
        let _ = win.set_always_on_top(false);
        let _ = win.set_ignore_cursor_events(false);
        if let Some(main) = win.app_handle().get_webview_window("main") {
            let _ = main.set_ignore_cursor_events(false);
            let _ = main.emit("force-main-interactive", ());
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn run_window_task_after_ipc<F>(
    app: &tauri::AppHandle,
    label: &'static str,
    task: F,
) -> Result<(), String>
where
    F: FnOnce(tauri::AppHandle) -> Result<(), String> + Send + 'static,
{
    if !cfg!(windows) {
        return task(app.clone());
    }

    diag_file_log(app, label, "scheduling window task after ipc");
    let app_for_timer = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let app_for_task = app_for_timer.clone();
        if let Err(err) = app_for_timer.run_on_main_thread(move || {
            diag_file_log(&app_for_task, label, "window task started");
            match task(app_for_task.clone()) {
                Ok(()) => diag_file_log(&app_for_task, label, "window task finished"),
                Err(err) => {
                    diag_file_log(&app_for_task, label, &format!("window task failed: {err}"))
                }
            }
        }) {
            diag_file_log(
                &app_for_timer,
                label,
                &format!("run_on_main_thread failed: {err}"),
            );
        }
    });
    Ok(())
}

struct AppWindowSpec {
    label: &'static str,
    url: &'static str,
    title: &'static str,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
    maximized: bool,
}

fn open_app_window_after_ipc(app: tauri::AppHandle, spec: AppWindowSpec) -> Result<(), String> {
    diag_file_log(&app, spec.label, &format!("open_{} called", spec.label));
    run_window_task_after_ipc(&app, spec.label, move |app| {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        diag_file_log(&app, spec.label, "window task started");
        if let Some(win) = app.get_webview_window(spec.label) {
            diag_file_log(&app, spec.label, "existing window found");
            let _ = win.show();
            let _ = win.set_focus();
            normalize_child_window(&win);
            return Ok(());
        }
        diag_file_log(&app, spec.label, "before window build");
        let win = WebviewWindowBuilder::new(&app, spec.label, WebviewUrl::App(spec.url.into()))
            .title(spec.title)
            .inner_size(spec.width, spec.height)
            .min_inner_size(spec.min_width, spec.min_height)
            .resizable(true)
            .maximized(spec.maximized)
            .build()
            .map_err(|e| e.to_string())?;
        diag_file_log(&app, spec.label, "window built");
        normalize_child_window(&win);
        attach_webview_diagnostics(&win, spec.label);
        Ok(())
    })
}

/// Ouvre une application depuis une commande de l'orbe physique.
///
/// La liste est volontairement fermée : aucun chemin ou URL provenant du
/// réseau n'est utilisé directement pour construire une WebView.
pub(crate) fn open_orb_app(app: tauri::AppHandle, id: &str) -> Result<(), String> {
    let spec = match id {
        "agents" => AppWindowSpec {
            label: "orb-agents",
            url: "agents/manager.html",
            title: "Lumen — Agents",
            width: 980.0,
            height: 660.0,
            min_width: 760.0,
            min_height: 520.0,
            maximized: false,
        },
        "designer" => AppWindowSpec {
            label: "fluxo-designer",
            url: "fluxo/designer.html",
            title: "Fluxo — Designer",
            width: 1180.0,
            height: 760.0,
            min_width: 860.0,
            min_height: 560.0,
            maximized: false,
        },
        "automations" => AppWindowSpec {
            label: "automations",
            url: "automations/automations.html",
            title: "Lumen — Automations",
            width: 1280.0,
            height: 820.0,
            min_width: 980.0,
            min_height: 620.0,
            maximized: false,
        },
        // « finance » reste accepté : d'anciens workflows / raccourcis peuvent
        // encore désigner l'app par son ancien nom.
        "budget" | "finance" => AppWindowSpec {
            label: "budget",
            url: "budget/budget.html",
            title: "Lumen — Budget",
            width: 1180.0,
            height: 780.0,
            min_width: 860.0,
            min_height: 600.0,
            maximized: false,
        },
        "calendar" => AppWindowSpec {
            label: "orb-calendar",
            url: "calendar/calendar.html",
            title: "Lumen — Calendrier",
            width: 1080.0,
            height: 740.0,
            min_width: 760.0,
            min_height: 520.0,
            maximized: false,
        },
        "notes" => AppWindowSpec {
            label: "orb-notes",
            url: "notes/notes.html",
            title: "Lumen — Notes",
            width: 980.0,
            height: 680.0,
            min_width: 720.0,
            min_height: 500.0,
            maximized: false,
        },
        "domotique" => AppWindowSpec {
            label: "orb-domotique",
            url: "domotique/domotique.html",
            title: "Lumen — Domotique",
            width: 1180.0,
            height: 780.0,
            min_width: 860.0,
            min_height: 560.0,
            maximized: false,
        },
        "games" => AppWindowSpec {
            label: "orb-games",
            url: "games/games.html",
            title: "Lumen — Jeux",
            width: 1100.0,
            height: 760.0,
            min_width: 760.0,
            min_height: 520.0,
            maximized: false,
        },
        _ => return Err(format!("application orbe inconnue: {id}")),
    };
    open_app_window_after_ipc(app, spec)
}

/// Normalise une URL Ollama : `localhost` → `127.0.0.1`. Sous Windows, `localhost`
/// se résout souvent en IPv6 (`::1`) alors qu'Ollama n'écoute que sur l'IPv4
/// `127.0.0.1`, d'où un échec de connexion. Forcer l'IPv4 règle ce cas courant.
pub(crate) fn normalize_ollama_url(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    let u = if u.is_empty() {
        "http://127.0.0.1:11434"
    } else {
        u
    };
    u.replace("://localhost", "://127.0.0.1")
}

/// Interroge Ollama (`GET {url}/api/tags`) **depuis le backend** et renvoie la
/// liste des modèles installés. Passer par Rust évite les écueils de la WebView
/// sous Windows : pas de blocage CORS (l'origine WebView2 `http://tauri.localhost`
/// peut être refusée par Ollama) et résolution réseau fiable (IPv4).
#[tauri::command]
async fn ollama_list_models(url: Option<String>) -> Result<Vec<String>, String> {
    let base = normalize_ollama_url(url.as_deref().unwrap_or("http://127.0.0.1:11434"));
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(format!("{base}/api/tags"))
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Ollama injoignable ({base}) : {e}"))?;
        let json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        let models = json
            .get("models")
            .and_then(|m| m.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(models)
    })
    .await
    .map_err(|e| format!("Tâche interrompue : {e}"))?
}

#[tauri::command]
async fn ollama_get_json(url: Option<String>, path: String) -> Result<serde_json::Value, String> {
    let base = normalize_ollama_url(url.as_deref().unwrap_or("http://127.0.0.1:11434"));
    let path = path.trim_start_matches('/').to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(format!("{base}/{path}"))
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Ollama injoignable ({base}/{path}) : {e}"))?;
        resp.json::<serde_json::Value>().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Tâche interrompue : {e}"))?
}

#[tauri::command]
async fn ollama_post_json(
    url: Option<String>,
    path: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let base = normalize_ollama_url(url.as_deref().unwrap_or("http://127.0.0.1:11434"));
    let path = path.trim_start_matches('/').to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .post(format!("{base}/{path}"))
            .json(&payload)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Ollama injoignable ({base}/{path}) : {e}"))?;
        resp.json::<serde_json::Value>().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Tâche interrompue : {e}"))?
}

/// Résultat d'une récupération de page web par le backend (app Navigateur).
#[derive(Clone, serde::Serialize)]
struct WebFetchResult {
    /// URL demandée (normalisée avec https:// si le schéma manquait).
    url: String,
    /// URL finale après redirections.
    final_url: String,
    /// Titre extrait de la balise <title> (vide si absent).
    title: String,
    /// Contenu lisible de la page converti en Markdown (titres, liens absolus,
    /// images, listes), tronqué si très long. Sert à la vue lecture ET à l'IA.
    text: String,
    /// Vrai si le texte a été tronqué (page trop longue pour le contexte LLM).
    truncated: bool,
    /// Vrai si la page peut être affichée en iframe (pas de X-Frame-Options
    /// DENY/SAMEORIGIN ni de CSP frame-ancestors restrictive). Le front l'utilise
    /// pour décider entre la vue live (iframe) et la vue lecture.
    embeddable: bool,
    /// Nature du document : "html", "pdf" ou "text". Le front adapte l'affichage
    /// (un PDF n'a pas de vue live possible, par exemple).
    kind: String,
    /// Vrai si la réponse vient du cache mémoire (retour/avance, relance d'une
    /// action IA) plutôt que du réseau.
    cached: bool,
}

/// User-agent envoyé par toutes les récupérations web.
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

/// Déplie la chaîne de causes d'une erreur reqwest. `error sending request for
/// url (…)` seul est inexploitable : la cause réelle (DNS, TLS, connexion
/// refusée, délai dépassé) est toujours un cran plus bas.
fn error_chain(err: &dyn std::error::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(e) = source {
        let text = e.to_string();
        if !parts.iter().any(|p| p == &text) {
            parts.push(text);
        }
        source = e.source();
    }
    parts.join(" — ")
}

/// Cache mémoire des pages récupérées. Le navigateur refait un `web_fetch` à
/// chaque retour/avance et chaque relance d'action IA : sans cache, la même page
/// est retéléchargée plusieurs fois de suite. Volontairement petit et éphémère —
/// c'est un cache de session, pas un archivage.
const WEB_CACHE_MAX: usize = 24;
const WEB_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);
static WEB_CACHE: std::sync::Mutex<Vec<(String, std::time::Instant, WebFetchResult)>> =
    std::sync::Mutex::new(Vec::new());

fn web_cache_get(url: &str) -> Option<WebFetchResult> {
    let mut cache = WEB_CACHE.lock().ok()?;
    cache.retain(|(_, at, _)| at.elapsed() < WEB_CACHE_TTL);
    cache
        .iter()
        .find(|(k, _, _)| k == url)
        .map(|(_, _, v)| v.clone())
}

fn web_cache_put(url: &str, value: &WebFetchResult) {
    if let Ok(mut cache) = WEB_CACHE.lock() {
        cache.retain(|(k, at, _)| k != url && at.elapsed() < WEB_CACHE_TTL);
        cache.push((url.to_string(), std::time::Instant::now(), value.clone()));
        while cache.len() > WEB_CACHE_MAX {
            cache.remove(0);
        }
    }
}

/// Récupère une page web **côté backend** (reqwest) pour les fonctionnalités IA de
/// l'app Navigateur. Passer par Rust contourne le CORS de la WebView : le front ne
/// peut pas lire une iframe cross-origin, mais l'IA a besoin du texte de la page.
/// Le HTML est nettoyé en texte simple (sans dépendance externe) et tronqué pour
/// tenir dans la fenêtre de contexte du modèle.
#[tauri::command]
async fn web_fetch(url: String, refresh: Option<bool>) -> Result<WebFetchResult, String> {
    let mut u = url.trim().to_string();
    if u.is_empty() {
        return Err("URL vide".into());
    }
    if !u.starts_with("http://") && !u.starts_with("https://") {
        u = format!("https://{u}");
    }
    if !refresh.unwrap_or(false) {
        if let Some(mut hit) = web_cache_get(&u) {
            hit.cached = true;
            return Ok(hit);
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            // User-agent de navigateur ordinaire. L'ancien (« Lumen; +local AI
            // browser ») était honnête mais contre-productif : les pages de
            // résultats coupent la connexion ou servent une version dégradée à
            // tout ce qui s'annonce comme un robot. Aucune donnée personnelle
            // n'y figure — c'est la chaîne la plus banale possible.
            .user_agent(BROWSER_UA)
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()
            .map_err(|e| e.to_string())?;
        // Deux tentatives : une coupure de connexion sur un moteur de recherche
        // est courante (limitation de débit) et passe presque toujours au
        // deuxième essai. Inutile d'insister au-delà.
        let mut attempt = 0;
        let resp = loop {
            attempt += 1;
            let sent = client
                .get(&u)
                .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                .header(reqwest::header::ACCEPT_LANGUAGE, "fr-FR,fr;q=0.9,en;q=0.8")
                .send();
            match sent.and_then(|r| r.error_for_status()) {
                Ok(r) => break r,
                Err(e) if attempt < 2 && (e.is_connect() || e.is_timeout() || e.is_request()) => {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                }
                // Le message d'erreur PART AU MODÈLE et à l'utilisateur : sans
                // la chaîne de causes, « error sending request » ne dit rien de
                // ce qu'il faut corriger.
                Err(e) => return Err(format!("Impossible de charger la page : {}", error_chain(&e))),
            }
        };
        let final_url = resp.url().to_string();
        let header = |name: &str| -> String {
            resp.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_lowercase()
        };
        let content_type = header("content-type");
        let xfo = header("x-frame-options");
        let csp = header("content-security-policy");
        // frame-ancestors présent = restrictif, sauf si autorise explicitement '*'.
        let fa_blocks = csp.find("frame-ancestors").is_some_and(|idx| {
            let seg = csp[idx..].split(';').next().unwrap_or("");
            !seg.contains('*')
        });
        let embeddable = !xfo.contains("deny") && !xfo.contains("sameorigin") && !fa_blocks;
        // On lit des octets, pas du texte : un PDF passé par `.text()` ressortait
        // en garbage. Le type est décidé par l'en-tête ET par la signature du
        // fichier, car beaucoup de serveurs annoncent application/octet-stream.
        let bytes = resp.bytes().map_err(|e| e.to_string())?;
        let is_pdf = content_type.contains("pdf") || bytes.starts_with(b"%PDF-");
        let (kind, title, mut text) = if is_pdf {
            let text = pdf_extract::extract_text_from_mem(&bytes)
                .map_err(|e| format!("PDF illisible : {e}"))?;
            (
                "pdf".to_string(),
                pdf_title_from_url(&final_url),
                normalize_extracted_text(&text),
            )
        } else {
            let body = String::from_utf8_lossy(&bytes).into_owned();
            let looks_html = content_type.contains("html") || body.trim_start().starts_with('<');
            if looks_html {
                let main = readable_html(&body);
                (
                    "html".to_string(),
                    extract_html_title(&body),
                    html_to_markdown(&main, &final_url),
                )
            } else {
                ("text".to_string(), String::new(), body)
            }
        };
        // Limite pour ne pas saturer le contexte du LLM (≈ 40 k caractères).
        const MAX: usize = 40_000;
        let truncated = text.len() > MAX;
        if truncated {
            let mut cut = MAX;
            while cut > 0 && !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
        }
        let out = WebFetchResult {
            url: u.clone(),
            final_url,
            title,
            text,
            truncated,
            // Un PDF ne s'affiche pas en iframe dans notre bac à sable.
            embeddable: embeddable && !is_pdf,
            kind,
            cached: false,
        };
        web_cache_put(&u, &out);
        Ok(out)
    })
    .await
    .map_err(|e| format!("Tâche interrompue : {e}"))?
}

/// Contenu BRUT d'une URL (CSV, JSON, texte), sans nettoyage ni troncature
/// « contexte LLM ». C'est ce que lit l'app Flux de données : `web_fetch`
/// coupe à 40 k caractères parce qu'il nourrit un modèle, et un export CSV
/// dépasse cette taille dès quelques centaines de lignes. Bornée tout de même
/// (32 Mo) : un flux n'a rien à faire d'une archive.
#[tauri::command]
async fn web_fetch_raw(url: String) -> Result<String, String> {
    let mut u = url.trim().to_string();
    if u.is_empty() {
        return Err("URL vide".into());
    }
    if !u.starts_with("http://") && !u.starts_with("https://") {
        u = format!("https://{u}");
    }
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .user_agent(BROWSER_UA)
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(&u)
            .header(reqwest::header::ACCEPT, "text/csv,application/json,text/plain,*/*;q=0.8")
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Impossible de charger l'URL : {}", error_chain(&e)))?;
        let bytes = resp.bytes().map_err(|e| e.to_string())?;
        const MAX: usize = 32 * 1024 * 1024;
        if bytes.len() > MAX {
            return Err("Contenu trop volumineux (plus de 32 Mo).".into());
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Variante de `web_fetch` qui EXÉCUTE le JavaScript de la page : la page est
/// chargée dans une WebView cachée, puis son DOM est passé dans exactement le
/// même pipeline de lecture (contenu principal → Markdown). À réserver aux pages
/// que `web_fetch` rend vides : ouvrir une WebView coûte bien plus cher qu'une
/// requête HTTP, et beaucoup de sites n'en ont aucun besoin.
#[tauri::command]
async fn web_fetch_rendered(app: tauri::AppHandle, url: String) -> Result<WebFetchResult, String> {
    let mut u = url.trim().to_string();
    if u.is_empty() {
        return Err("URL vide".into());
    }
    if !u.starts_with("http://") && !u.starts_with("https://") {
        u = format!("https://{u}");
    }
    let cache_key = format!("rendered:{u}");
    if let Some(mut hit) = web_cache_get(&cache_key) {
        hit.cached = true;
        return Ok(hit);
    }
    let html = web_render::render_html(&app, &u).await?;
    let main = readable_html(&html);
    let mut text = html_to_markdown(&main, &u);
    const MAX: usize = 40_000;
    let truncated = text.len() > MAX;
    if truncated {
        let mut cut = MAX;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    let out = WebFetchResult {
        url: u.clone(),
        final_url: u.clone(),
        title: extract_html_title(&html),
        text,
        truncated,
        embeddable: false,
        kind: "html".into(),
        cached: false,
    };
    web_cache_put(&cache_key, &out);
    Ok(out)
}

/// Extrait le contenu de la balise `<title>` (insensible à la casse). Vide si absent.
fn extract_html_title(html: &str) -> String {
    // to_ascii_lowercase() préserve la longueur en octets (A-Z → a-z uniquement),
    // donc les offsets calculés sur `lower` restent valides sur `html`.
    let lower = html.to_ascii_lowercase();
    if let Some(start) = lower.find("<title") {
        if let Some(gt) = lower[start..].find('>') {
            let content_start = start + gt + 1;
            if let Some(end) = lower[content_start..].find("</title>") {
                return decode_entities(html[content_start..content_start + end].trim());
            }
        }
    }
    String::new()
}

/// Conteneurs susceptibles de porter le corps d'un article. `section` et `div`
/// ne sont retenus que si leurs attributs le suggèrent (cf. `looks_like_content`).
const READABLE_TAGS: [&str; 4] = ["article", "main", "section", "div"];

/// Isole la portion « contenu principal » d'une page HTML, à la façon des vues
/// lecture des navigateurs. L'ancienne approche retirait aveuglément
/// `nav`/`aside`/`footer` : sur beaucoup de sites, cela emportait aussi du vrai
/// contenu, et sur d'autres cela laissait passer menus et pieds de page dans le
/// texte envoyé au modèle. Ici on note les conteneurs candidats et on garde
/// celui qui offre le plus de texte pour le moins de liens.
///
/// En l'absence de candidat convaincant, on renvoie le document nettoyé : le
/// pipeline retombe alors exactement sur le comportement historique, ce qui
/// préserve les pages atypiques (résultats de recherche, pages tout en liens).
fn readable_html(html: &str) -> String {
    let mut cleaned = html.to_string();
    for tag in ["script", "style", "noscript", "template", "svg", "head"] {
        cleaned = strip_block(&cleaned, tag);
    }
    // to_ascii_lowercase() préserve la longueur en octets : les offsets calculés
    // sur `lower` restent valides sur `cleaned`.
    let lower = cleaned.to_ascii_lowercase();

    let mut cands: Vec<Candidate> = candidate_ranges(&lower)
        .into_iter()
        .map(|(semantic, start, end)| Candidate {
            semantic,
            start,
            end,
            score: content_score(&cleaned[start..end]),
        })
        .filter(|c| c.score > 0.0)
        .collect();
    if cands.is_empty() {
        return cleaned;
    }
    cands.sort_by(|a, b| b.score.total_cmp(&a.score));

    // Le conteneur le mieux noté est souvent trop large : un `<main>` de
    // Wikipédia contient l'article MAIS aussi la liste des 179 langues. On
    // redescend donc tant qu'un conteneur imbriqué reste convaincant — soit
    // parce qu'il est sémantique, soit parce qu'il conserve l'essentiel du
    // texte de son parent. C'est ce resserrage qui distingue une vraie vue
    // lecture d'un simple décapage de balises.
    let mut best = cands[0];
    for _ in 0..8 {
        let inner = cands
            .iter()
            .filter(|c| {
                c.start >= best.start && c.end <= best.end && (c.start, c.end) != (best.start, best.end)
            })
            .filter(|c| c.semantic || c.score >= best.score * 0.75)
            .max_by(|a, b| {
                a.semantic
                    .cmp(&b.semantic)
                    .then_with(|| a.score.total_cmp(&b.score))
            })
            .copied();
        match inner {
            Some(c) => best = c,
            None => break,
        }
    }
    if best.score >= 500.0 {
        cleaned[best.start..best.end].to_string()
    } else {
        cleaned
    }
}

/// Un conteneur candidat au titre de « contenu principal ».
#[derive(Clone, Copy)]
struct Candidate {
    semantic: bool,
    start: usize,
    end: usize,
    score: f64,
}

/// Parcourt le HTML une seule fois et renvoie les plages internes des conteneurs
/// candidats : `(sémantique, début, fin)`. La pile suit tous les conteneurs
/// surveillés pour que l'imbrication reste juste, même sur du HTML mal fermé.
fn candidate_ranges(lower: &str) -> Vec<(bool, usize, usize)> {
    let bytes = lower.as_bytes();
    // (nom, début du contenu, candidat, sémantique)
    let mut stack: Vec<(String, usize, bool, bool)> = Vec::new();
    let mut out: Vec<(bool, usize, usize)> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let Some(rel) = lower[i..].find('>') else { break };
        let end = i + rel;
        let tag = &lower[i + 1..end];
        let closing = tag.starts_with('/');
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        if READABLE_TAGS.contains(&name.as_str()) && !tag.ends_with('/') {
            if closing {
                if let Some(pos) = stack.iter().rposition(|(n, ..)| *n == name) {
                    // split_off abandonne au passage les conteneurs restés
                    // ouverts à l'intérieur : c'est le comportement voulu.
                    let mut tail = stack.split_off(pos);
                    let (_, inner_start, candidate, semantic) = tail.remove(0);
                    if candidate && i > inner_start {
                        out.push((semantic, inner_start, i));
                    }
                }
            } else {
                let attrs = &lower[i..end];
                let semantic =
                    name == "article" || name == "main" || attrs.contains("role=\"main\"");
                let candidate = semantic || looks_like_content(attrs);
                stack.push((name, end + 1, candidate, semantic));
            }
        }
        i = end + 1;
    }
    out
}

/// Vrai si les attributs d'un conteneur évoquent le corps d'un article. On exige
/// un indice positif ET l'absence d'indice négatif : un `div class="post-comments"`
/// contient bien « post », mais ce n'est pas l'article.
fn looks_like_content(attrs: &str) -> bool {
    const POSITIVE: [&str; 8] = [
        "article", "content", "post", "entry", "story", "main", "markdown", "prose",
    ];
    const NEGATIVE: [&str; 12] = [
        "comment", "sidebar", "footer", "header", "nav", "menu", "promo", "banner", "share",
        "related", "cookie", "popup",
    ];
    if NEGATIVE.iter().any(|n| attrs.contains(n)) {
        return false;
    }
    POSITIVE.iter().any(|p| attrs.contains(p))
}

/// Note un conteneur : beaucoup de texte, peu de liens. Une densité de liens
/// élevée signale une navigation, un sommaire ou une liste de résultats — pas le
/// corps d'un article.
fn content_score(inner: &str) -> f64 {
    let (text_len, link_len) = text_and_link_len(inner);
    if text_len < 200 {
        return 0.0;
    }
    let density = link_len as f64 / text_len as f64;
    if density > 0.5 {
        return 0.0;
    }
    text_len as f64 * (1.0 - density)
}

/// Longueur du texte visible et de la part située dans des liens, en une passe.
fn text_and_link_len(html: &str) -> (usize, usize) {
    let mut text = 0usize;
    let mut link = 0usize;
    let mut depth = 0i32;
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let Some(rel) = html[i..].find('>') else { break };
            let tag = &html[i + 1..i + rel];
            let name: String = tag
                .trim_start_matches('/')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase();
            if name == "a" && !tag.ends_with('/') {
                if tag.starts_with('/') {
                    depth = (depth - 1).max(0);
                } else {
                    depth += 1;
                }
            }
            i += rel + 1;
        } else {
            let next = html[i..].find('<').map(|e| i + e).unwrap_or(html.len());
            let n = html[i..next].split_whitespace().map(str::len).sum::<usize>();
            text += n;
            if depth > 0 {
                link += n;
            }
            i = next;
        }
    }
    (text, link)
}

/// Titre de repli pour un PDF : le nom de fichier de l'URL, rendu lisible.
fn pdf_title_from_url(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    // On repart du chemin, pas de l'URL entière : sans cela « https://x.org/ »
    // aurait donné « x.org » comme titre de document.
    let path = path
        .split_once("://")
        .map_or(path, |(_, rest)| rest.split_once('/').map_or("", |(_, p)| p));
    let name = path.rsplit('/').find(|s| !s.is_empty()).unwrap_or("");
    let stem = name.strip_suffix(".pdf").unwrap_or(name);
    let pretty = stem.replace(['-', '_', '%'], " ");
    let pretty = pretty.split_whitespace().collect::<Vec<_>>().join(" ");
    if pretty.is_empty() {
        "Document PDF".to_string()
    } else {
        pretty
    }
}

/// Nettoie un texte extrait (PDF) : lignes rognées, au plus une ligne vide.
fn normalize_extracted_text(text: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut blank = false;
    for raw in text.lines() {
        let line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            if !blank && !lines.is_empty() {
                lines.push(String::new());
            }
            blank = true;
        } else {
            lines.push(line);
            blank = false;
        }
    }
    lines.join("\n").trim().to_string()
}

/// Convertit du HTML en Markdown lisible sans dépendance externe : retire les
/// blocs non-contenu, préserve titres/liens/images/listes (URLs rendues
/// absolues via `base`), décode les entités et normalise les espaces.
fn html_to_markdown(html: &str, base: &str) -> String {
    let mut s = html.to_string();
    for tag in [
        "script", "style", "noscript", "template", "svg", "head", "nav", "footer",
        "form", "iframe", "aside",
    ] {
        s = strip_block(&s, tag);
    }
    let mut out = String::with_capacity(s.len() / 2);
    // Texte du lien en cours d'accumulation (entre <a> et </a>).
    let mut link_text: Option<String> = None;
    let mut link_href = String::new();
    let mut i = 0;
    while i < s.len() {
        if s.as_bytes()[i] == b'<' {
            let end = match s[i..].find('>') {
                Some(e) => i + e,
                None => break,
            };
            let tag = &s[i + 1..end];
            handle_md_tag(tag, &mut out, &mut link_text, &mut link_href, base);
            i = end + 1;
        } else {
            let next = s[i..].find('<').map(|e| i + e).unwrap_or(s.len());
            let text = decode_entities(&s[i..next]);
            if let Some(lt) = link_text.as_mut() {
                lt.push_str(&text);
            } else {
                out.push_str(&text);
            }
            i = next;
        }
    }
    // Normalise : lignes rognées, au plus une ligne vide consécutive.
    let mut lines: Vec<String> = Vec::new();
    let mut blank = false;
    for raw in out.split('\n') {
        let line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            if !blank && !lines.is_empty() {
                lines.push(String::new());
            }
            blank = true;
        } else {
            lines.push(line);
            blank = false;
        }
    }
    lines.join("\n").trim().to_string()
}

/// Traite une balise (contenu entre `<` et `>`) pour la conversion Markdown.
fn handle_md_tag(
    tag: &str,
    out: &mut String,
    link_text: &mut Option<String>,
    link_href: &mut String,
    base: &str,
) {
    let t = tag.trim();
    let closing = t.starts_with('/');
    let name: String = t
        .trim_start_matches('/')
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    match name.as_str() {
        "a" => {
            if closing {
                if let Some(txt) = link_text.take() {
                    let txt = txt.split_whitespace().collect::<Vec<_>>().join(" ");
                    if !txt.is_empty() && !link_href.is_empty() {
                        out.push_str(&format!("[{txt}]({link_href})"));
                    } else if !txt.is_empty() {
                        out.push_str(&txt);
                    }
                }
                link_href.clear();
            } else {
                *link_href = absolutize_url(&attr_value(t, "href").unwrap_or_default(), base);
                *link_text = Some(String::new());
            }
        }
        "img" if !closing => {
            let src = attr_value(t, "src").unwrap_or_default();
            let alt = attr_value(t, "alt").unwrap_or_default();
            if !src.is_empty() {
                let u = absolutize_url(&src, base);
                if let Some(lt) = link_text.as_mut() {
                    lt.push_str(&alt);
                } else {
                    out.push_str(&format!("\n![{alt}]({u})\n"));
                }
            }
        }
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" if !closing => {
            let n = name[1..].parse::<usize>().unwrap_or(1);
            out.push_str("\n\n");
            for _ in 0..n {
                out.push('#');
            }
            out.push(' ');
        }
        "li" if !closing => out.push_str("\n- "),
        "br" => out.push('\n'),
        "p" | "div" | "section" | "article" | "tr" | "ul" | "ol" | "table"
        | "blockquote" | "pre" | "header" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            out.push('\n')
        }
        _ => {}
    }
}

/// Valeur d'un attribut dans une balise (guillemets simples/doubles ou sans).
fn attr_value(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let key = format!("{name}=");
    let pos = lower.find(&key)?;
    let after = tag[pos + key.len()..].trim_start();
    let bytes = after.as_bytes();
    if bytes.is_empty() {
        return Some(String::new());
    }
    let q = bytes[0];
    if q == b'"' || q == b'\'' {
        let rest = &after[1..];
        let end = rest.find(q as char)?;
        Some(decode_entities(&rest[..end]))
    } else {
        let end = after.find(char::is_whitespace).unwrap_or(after.len());
        Some(decode_entities(&after[..end]))
    }
}

/// Rend une URL absolue par rapport à `base` (URL finale de la page).
fn absolutize_url(href: &str, base: &str) -> String {
    let h = href.trim();
    if h.is_empty()
        || h.starts_with('#')
        || h.starts_with("javascript:")
        || h.starts_with("mailto:")
        || h.starts_with("tel:")
        || h.starts_with("data:")
        || h.starts_with("http://")
        || h.starts_with("https://")
    {
        return h.to_string();
    }
    let (scheme, rest) = if let Some(r) = base.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = base.strip_prefix("http://") {
        ("http", r)
    } else {
        ("https", base)
    };
    if h.starts_with("//") {
        return format!("{scheme}:{h}");
    }
    let host_end = rest.find('/').unwrap_or(rest.len());
    let origin = format!("{scheme}://{}", &rest[..host_end]);
    if h.starts_with('/') {
        return format!("{origin}{h}");
    }
    // Relatif au répertoire du chemin courant.
    let path = &rest[host_end..];
    let dir = match path.rfind('/') {
        Some(idx) => &path[..idx + 1],
        None => "/",
    };
    format!("{origin}{dir}{h}")
}

/// Supprime tout bloc `<tag ...> ... </tag>` (insensible à la casse), y compris
/// les balises auto-fermantes du même nom.
fn strip_block(input: &str, tag: &str) -> String {
    // to_ascii_lowercase() : longueur en octets préservée → offsets valides sur `input`.
    let lower = input.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if lower[i..].starts_with(&open) {
            if let Some(rel) = lower[i..].find(&close) {
                i += rel + close.len();
                continue;
            } else if let Some(rel) = lower[i..].find('>') {
                // Balise ouvrante sans fermeture explicite : on saute juste la balise.
                i += rel + 1;
                continue;
            } else {
                break;
            }
        }
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Décode les entités HTML les plus courantes (suffisant pour du texte de lecture).
fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&hellip;", "…")
        .replace("&rsquo;", "'")
        .replace("&lsquo;", "'")
        .replace("&ldquo;", "\u{201C}")
        .replace("&rdquo;", "\u{201D}")
}

/// Télécharge un modèle Ollama (`POST {url}/api/pull`) **depuis le backend**, en
/// streaming NDJSON. Émet l'évènement `ollama-pull-progress` à chaque ligne pour
/// que l'UI affiche une barre de progression — l'utilisateur n'a jamais à ouvrir
/// un terminal ni à taper `ollama pull`. À la fin, émet `ollama-pull-done`.
#[tauri::command]
async fn ollama_pull(
    app: tauri::AppHandle,
    url: Option<String>,
    model: String,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    let base = normalize_ollama_url(url.as_deref().unwrap_or("http://127.0.0.1:11434"));
    let model_for_evt = model.clone();
    let app_done = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(None) // un pull peut durer plusieurs minutes
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .post(format!("{base}/api/pull"))
            .json(&serde_json::json!({ "model": model, "stream": true }))
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Ollama injoignable ({base}) : {e}"))?;
        let reader = BufReader::new(resp);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
                let status = json.get("status").and_then(|s| s.as_str()).unwrap_or("");
                let total = json.get("total").and_then(|t| t.as_u64()).unwrap_or(0);
                let completed = json.get("completed").and_then(|c| c.as_u64()).unwrap_or(0);
                let pct = if total > 0 {
                    ((completed as f64 / total as f64) * 100.0).round() as u64
                } else {
                    0
                };
                let _ = app.emit(
                    "ollama-pull-progress",
                    serde_json::json!({
                        "model": model,
                        "status": status,
                        "total": total,
                        "completed": completed,
                        "percent": pct,
                    }),
                );
                if let Some(err) = json.get("error").and_then(|e| e.as_str()) {
                    return Err(err.to_string());
                }
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Tâche interrompue : {e}"))?;

    let ok = result.is_ok();
    let _ = app_done.emit(
        "ollama-pull-done",
        serde_json::json!({
            "model": model_for_evt,
            "ok": ok,
            "error": result.as_ref().err().cloned().unwrap_or_default(),
        }),
    );
    result
}

// ===== Notification flottante =====
//
// Une petite fenêtre flottante distincte de la barre principale : capsule en
// verre, sans bordure, toujours au premier plan, fixée en haut-centre de
// l'écran. Créée à la demande (lazy) au premier `push_notification`. Le contenu
// (prompt ou notif) arrive via le serveur axum local (`POST /notify`) ou via la
// commande `notify_island` depuis la WebView principale.

/// Label de la fenêtre island (référencé aussi dans `capabilities/default.json`).
const ISLAND_LABEL: &str = "island";
/// Largeur fixe (px logiques). Seule la hauteur s'adapte au contenu côté JS.
const ISLAND_WIDTH: f64 = 420.0;
/// Marge sous la barre de menus / notch.
const ISLAND_TOP: f64 = 12.0;

/// File des notifications en attente : permet à la fenêtre de « rattraper » les
/// notifs émises pendant son démarrage à froid (avant que le listener JS existe).
#[derive(Default)]
struct IslandQueue(std::sync::Mutex<Vec<serde_json::Value>>);

/// Mode « Halo » : quand il est actif, la capsule reste affichée en permanence
/// (agents en cours, notifications, horloge) au lieu d'apparaître le temps d'une
/// notification. `island_hide` devient alors sans effet.
static HALO_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn halo_enabled() -> bool {
    HALO_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Ancrage horizontal de la capsule : "center" (défaut), "left" ou "right".
/// Réglable depuis les Réglages → Notifications.
static HALO_POS: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
/// Marge au bord de l'écran pour les ancrages latéraux.
const HALO_EDGE: f64 = 14.0;

fn halo_position() -> String {
    HALO_POS
        .lock()
        .ok()
        .map(|p| p.clone())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "center".to_string())
}

/// Style de la capsule : "float" (pastille flottante sous la barre des menus,
/// défaut) ou "notch" (collée au bord supérieur, fondue dans l'encoche du Mac ;
/// sur un écran sans encoche, languette noire accrochée au bord).
static HALO_STYLE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

fn halo_notch_style() -> bool {
    HALO_STYLE.lock().map(|s| s.as_str() == "notch").unwrap_or(false)
}

/// Premier plan de la capsule. En style Encoche, au-dessus de la barre des
/// menus (NSStatusWindowLevel) : sinon la barre la recouvrirait. À rappeler
/// après chaque `set_always_on_top`, qui repose le niveau « flottant ».
fn halo_raise(win: &tauri::WebviewWindow) {
    let _ = win.set_always_on_top(true);
    #[cfg(target_os = "macos")]
    if halo_notch_style() {
        if let Ok(ptr) = win.ns_window() {
            // SAFETY : pointeur NSWindow vivant fourni par tao, appelé sur le
            // thread principal (toutes les voies d'appel y passent).
            unsafe {
                let obj: &objc2::runtime::AnyObject = &*(ptr as *const objc2::runtime::AnyObject);
                let _: () = objc2::msg_send![obj, setLevel: 25isize];
            }
        }
        halo_pin_top(win);
    }
}

/// Style Encoche : colle la fenêtre au bord HAUT de son écran, centrée.
/// `set_position` de Tauri passe par un chemin que macOS contraint sous la
/// barre des menus (la capsule restait ~37 pt plus bas) : on pose donc le
/// coin supérieur gauche directement sur le NSWindow, en coordonnées Cocoa
/// (origine en bas à gauche), après avoir élevé le niveau de la fenêtre.
#[cfg(target_os = "macos")]
fn halo_pin_top(win: &tauri::WebviewWindow) {
    let Ok(ptr) = win.ns_window() else { return };
    // SAFETY : NSWindow vivant, thread principal.
    unsafe {
        let obj: &objc2::runtime::AnyObject = &*(ptr as *const objc2::runtime::AnyObject);
        let _ = halo_frame_at_top(obj, true);
    }
    // `set_position`/`set_size` de tao sont rejoués en différé sur la file
    // principale : on ré-épingle juste après, sinon ils repassent derrière.
    let w2 = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(90));
        let w3 = w2.clone();
        let _ = w2.run_on_main_thread(move || halo_pin_top_now(&w3));
    });
}

/// Ré-épinglage différé (sans relancer de minuterie).
#[cfg(target_os = "macos")]
fn halo_pin_top_now(win: &tauri::WebviewWindow) {
    let Ok(ptr) = win.ns_window() else { return };
    // SAFETY : NSWindow vivant, thread principal.
    unsafe {
        let obj: &objc2::runtime::AnyObject = &*(ptr as *const objc2::runtime::AnyObject);
        let _ = halo_frame_at_top(obj, false);
    }
}

/// Pose le cadre de la capsule collé au bord haut de son écran, centré.
/// AppKit ne contraint sous la barre des menus que les fenêtres À BARRE DE
/// TITRE (`constrainFrameRect:toScreen:`) : si tao en a laissé une (masquée),
/// on retire ce seul trait du masque de style. Pas de sous-classe ni de
/// changement de classe à chaud : ça cassait la fenêtre (cadre 0×0 puis
/// exception dans makeKeyAndOrderFront).
#[cfg(target_os = "macos")]
unsafe fn halo_frame_at_top(obj: &objc2::runtime::AnyObject, log: bool) -> Option<()> {
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    const TITLED: usize = 1;
    // Niveau « barre d'état » (25) réimposé à CHAQUE placement : tao le remet à
    // son niveau flottant à chaque affichage/redimensionnement, et sous le
    // niveau de la barre des menus (24) macOS replace la fenêtre sous elle.
    let _: () = objc2::msg_send![obj, setLevel: 25isize];
    let mask: usize = objc2::msg_send![obj, styleMask];
    if mask & TITLED != 0 {
        let _: () = objc2::msg_send![obj, setStyleMask: mask & !TITLED];
    }
    let screen: *mut objc2::runtime::AnyObject = objc2::msg_send![obj, screen];
    if screen.is_null() {
        return None;
    }
    let sf: NSRect = objc2::msg_send![&*screen, frame];
    let wf: NSRect = objc2::msg_send![obj, frame];
    if wf.size.width < 1.0 || wf.size.height < 1.0 {
        return None;
    }
    let target = NSRect::new(
        NSPoint::new(sf.origin.x + (sf.size.width - wf.size.width) / 2.0, sf.origin.y + sf.size.height - wf.size.height),
        NSSize::new(wf.size.width, wf.size.height),
    );
    let _: () = objc2::msg_send![obj, setFrame: target, display: true];
    let after: NSRect = objc2::msg_send![obj, frame];
    if log {
        let level: isize = objc2::msg_send![obj, level];
        halo_log(&format!(
            "pin masque={mask:#x} niveau={level} écran=({},{} {}x{}) avant=({},{} {}x{}) après=({},{} {}x{})",
            sf.origin.x, sf.origin.y, sf.size.width, sf.size.height,
            wf.origin.x, wf.origin.y, wf.size.width, wf.size.height,
            after.origin.x, after.origin.y, after.size.width, after.size.height,
        ));
    }
    Some(())
}

/// Journal de diagnostic de la capsule : ~/Library/Logs/Lumen/halo.log.
fn halo_log(line: &str) {
    eprintln!("[halo] {line}");
    if let Ok(home) = std::env::var("HOME") {
        let dir = std::path::Path::new(&home).join("Library/Logs/Lumen");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("halo.log")) {
            use std::io::Write;
            let _ = writeln!(f, "{} {line}", chrono_like_now());
        }
    }
}
fn chrono_like_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
#[cfg(not(target_os = "macos"))]
fn halo_pin_top(_win: &tauri::WebviewWindow) {}

fn is_main_thread() -> bool {
    #[cfg(target_os = "macos")]
    return objc2::MainThreadMarker::new().is_some();
    #[cfg(not(target_os = "macos"))]
    return true;
}

/// Encoche de l'écran de taille `w`×`h` (points) : (largeur, hauteur), ou None
/// pour un écran sans encoche. Mesurée par NSScreen : la largeur est ce qui
/// reste entre les deux « oreilles » de part et d'autre de la caméra.
#[cfg(target_os = "macos")]
fn screen_notch(w: f64, h: f64) -> Option<(f64, f64)> {
    let mtm = objc2::MainThreadMarker::new()?;
    let screens = objc2_app_kit::NSScreen::screens(mtm);
    for sc in screens.iter() {
        let f = sc.frame();
        halo_log(&format!("écran {}x{} (moniteur {w}x{h}) inset_haut={}", f.size.width, f.size.height, sc.safeAreaInsets().top));
        if (f.size.width - w).abs() > 1.0 || (f.size.height - h).abs() > 1.0 {
            continue;
        }
        let top = sc.safeAreaInsets().top;
        if top <= 0.0 {
            return None;
        }
        let l = sc.auxiliaryTopLeftArea();
        let r = sc.auxiliaryTopRightArea();
        let nw = f.size.width - l.size.width - r.size.width;
        return (nw > 40.0).then_some((nw, top));
    }
    None
}
#[cfg(not(target_os = "macos"))]
fn screen_notch(_w: f64, _h: f64) -> Option<(f64, f64)> {
    None
}

/// Place la capsule en haut de l'écran qui la contient (ou l'écran principal si
/// elle n'est pas encore mappée), selon l'ancrage choisi (`HALO_POS`).
fn position_halo_window(win: &tauri::WebviewWindow) {
    position_halo_window_sized(win, None)
}

/// Idem, mais avec la largeur VOULUE plutôt que celle rapportée par la fenêtre.
/// `set_size` n'est pas immédiat sur macOS : juste après un redimensionnement,
/// `outer_size()` renvoie encore l'ancienne largeur, et le centrage calculé
/// dessus décalait la capsule vers la gauche à chaque rétrécissement.
fn position_halo_window_sized(win: &tauri::WebviewWindow, wanted_width: Option<f64>) {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let mon_w = monitor.size().width as f64 / scale;
    let mon_x = monitor.position().x as f64 / scale;
    let mon_y = monitor.position().y as f64 / scale;
    let win_w = wanted_width.unwrap_or_else(|| {
        win.outer_size()
            .map(|s| s.width as f64 / scale)
            .unwrap_or(ISLAND_WIDTH)
    });
    // Style Encoche : toujours centrée et collée au bord (l'encoche est au milieu).
    let notch = halo_notch_style();
    let x = match halo_position().as_str() {
        _ if notch => mon_x + (mon_w - win_w) / 2.0,
        "left" => mon_x + HALO_EDGE,
        "right" => mon_x + mon_w - win_w - HALO_EDGE,
        _ => mon_x + (mon_w - win_w) / 2.0,
    };
    let y = mon_y + if notch { 0.0 } else { ISLAND_TOP };
    let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    if notch {
        halo_pin_top(win);
    }
}

/// Récupère (ou crée) la fenêtre island. À appeler sur le thread principal.
fn ensure_island_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(win) = app.get_webview_window(ISLAND_LABEL) {
        return Some(win);
    }
    match WebviewWindowBuilder::new(app, ISLAND_LABEL, WebviewUrl::App("island.html".into()))
        .title("Lumen")
        .inner_size(ISLAND_WIDTH, 92.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .visible(false)
        // Glisser un fichier SUR la capsule = « pose une question dessus » :
        // le dépôt HTML5 (DataTransfer) n'arrive à la page qu'une fois le
        // gestionnaire natif de Tauri désactivé.
        .disable_drag_drop_handler()
        .build()
    {
        Ok(win) => Some(win),
        Err(e) => {
            eprintln!("[island] création impossible : {e}");
            None
        }
    }
}

/// Pousse une notification vers la fenêtre island (création paresseuse incluse).
/// Appelable depuis n'importe quel thread (le travail fenêtre est replié sur le
/// thread principal, requis par macOS).
pub fn push_notification(app: &tauri::AppHandle, payload: serde_json::Value) {
    // Le compagnon mobile porte la même capsule : toute notification poussée
    // ici (compte rendu d'agent, rappel, carte météo ou score) part aussi vers
    // les téléphones connectés.
    companion::push_to_phones(
        app,
        serde_json::json!({ "type": "halo-notify", "notification": payload.clone() }),
    );
    if let Some(q) = app.try_state::<IslandQueue>() {
        if let Ok(mut v) = q.0.lock() {
            v.push(payload);
        }
    }
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let warm = app.get_webview_window(ISLAND_LABEL).is_some();
        if let Some(win) = ensure_island_window(&app) {
            position_halo_window(&win);
            let _ = win.show();
            halo_raise(&win);
            // Fenêtre déjà ouverte : son listener est prêt, on le réveille.
            // Démarrage à froid : island.js draine la file à son chargement.
            if warm {
                let _ = win.emit("notify-poke", ());
            }
        }
    });
}

/// Vide et renvoie la file des notifications en attente (appelée par island.js
/// au chargement, puis à chaque `notify-poke`).
#[tauri::command]
fn island_drain(state: tauri::State<IslandQueue>) -> Vec<serde_json::Value> {
    state
        .0
        .lock()
        .map(|mut v| std::mem::take(&mut *v))
        .unwrap_or_default()
}

/// Ajuste la taille de la fenêtre island au contenu mesuré côté JS et la
/// recentre en haut.
#[tauri::command]
fn island_set_size(app: tauri::AppHandle, width: f64, height: f64) {
    if let Some(win) = app.get_webview_window(ISLAND_LABEL) {
        let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
        // Recentrage sur la largeur DEMANDÉE : la fenêtre n'a pas encore
        // forcément adopté la nouvelle taille au moment où on la replace.
        // Sur le thread principal : l'épinglage Encoche parle à AppKit.
        let w2 = win.clone();
        let _ = app.run_on_main_thread(move || position_halo_window_sized(&w2, Some(width)));
    }
}

/// Masque la fenêtre island (après l'animation de sortie). On la garde en vie
/// pour les notifs suivantes plutôt que de la détruire à chaque fois.
#[tauri::command]
fn island_hide(app: tauri::AppHandle) {
    // En mode Halo la capsule est persistante : elle se replie en pastille au
    // lieu de disparaître, c'est la vue JS qui gère le repli.
    if halo_enabled() {
        return;
    }
    if let Some(win) = app.get_webview_window(ISLAND_LABEL) {
        let _ = win.hide();
    }
}

/// Active ou coupe le mode Halo (capsule persistante). Appelé par la barre au
/// démarrage et à chaque changement du réglage.
#[tauri::command]
fn halo_set_enabled(app: tauri::AppHandle, enabled: bool) {
    HALO_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if enabled {
            if let Some(win) = ensure_island_window(&app2) {
                position_halo_window(&win);
                let _ = win.show();
                halo_raise(&win);
                let _ = win.emit("halo-mode", true);
            }
        } else if let Some(win) = app2.get_webview_window(ISLAND_LABEL) {
            let _ = win.emit("halo-mode", false);
            let _ = win.hide();
        }
    });
}

/// Change l'ancrage horizontal de la capsule et la replace aussitôt.
#[tauri::command]
fn halo_set_position(app: tauri::AppHandle, position: String) {
    if let Ok(mut p) = HALO_POS.lock() {
        *p = match position.as_str() {
            "left" | "right" => position,
            _ => "center".to_string(),
        };
    }
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(win) = app.get_webview_window(ISLAND_LABEL) {
            position_halo_window(&win);
        }
    });
}

/// Change le style de la capsule ("float" | "notch"), la replace et prévient
/// la vue (qui adopte la forme d'encoche et réserve la place de la caméra).
#[tauri::command]
fn halo_set_style(app: tauri::AppHandle, style: String) {
    if let Ok(mut s) = HALO_STYLE.lock() {
        *s = if style == "notch" { "notch".into() } else { "float".into() };
    }
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(win) = app.get_webview_window(ISLAND_LABEL) {
            position_halo_window(&win);
            if win.is_visible().unwrap_or(false) {
                halo_raise(&win);
            }
            let _ = win.emit("halo-style", halo_style_info(&win));
        }
    });
}

/// Style courant + dimensions de l'encoche de l'écran de la capsule.
fn halo_style_info(win: &tauri::WebviewWindow) -> serde_json::Value {
    let notch = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())
        .and_then(|m| {
            let sc = m.scale_factor();
            screen_notch(m.size().width as f64 / sc, m.size().height as f64 / sc)
        });
    halo_log(&format!("style={} encoche={:?} main={}", if halo_notch_style() { "notch" } else { "float" }, notch, is_main_thread()));
    serde_json::json!({
        "style": if halo_notch_style() { "notch" } else { "float" },
        "notchWidth": notch.map(|n| n.0).unwrap_or(0.0),
        "notchHeight": notch.map(|n| n.1).unwrap_or(0.0),
    })
}

/// Fichier déposé sur la capsule : la barre passe au premier plan pour qu'on
/// tape la question (les fichiers eux-mêmes voyagent par l'évènement
/// `capsule-drop`, émis par la capsule).
#[tauri::command]
fn capsule_focus_main(app: tauri::AppHandle) {
    focus_main_window(&app);
}

/// Interrogé par la capsule au chargement (fenêtre recréée après le réglage).
#[tauri::command]
fn halo_get_style(app: tauri::AppHandle) -> serde_json::Value {
    // La mesure de l'encoche (NSScreen) exige le thread principal : on la
    // refait là-bas et on la renvoie par l'évènement `halo-style`.
    let a2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = a2.get_webview_window(ISLAND_LABEL) {
            let info = halo_style_info(&win);
            let _ = win.emit("halo-style", info);
        }
    });
    match app.get_webview_window(ISLAND_LABEL) {
        Some(win) => halo_style_info(&win),
        None => serde_json::json!({ "style": if halo_notch_style() { "notch" } else { "float" }, "notchWidth": 0, "notchHeight": 0 }),
    }
}

/// État courant du mode Halo — la capsule l'interroge au chargement, au cas où
/// la fenêtre aurait été (re)créée alors que le mode est déjà actif.
#[tauri::command]
fn halo_is_enabled() -> bool {
    halo_enabled()
}

/// Réaffiche la capsule (mode notification : la fenêtre existe déjà mais est
/// masquée, et un évènement diffusé — pas une file drainée — l'a réveillée).
#[tauri::command]
fn island_show(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window(ISLAND_LABEL) {
        position_halo_window(&win);
        let _ = win.show();
        halo_raise(&win);
    }
}

/// Pousse une bulle vers la capsule. `only_when_closed` : ne pousse que si la
/// capsule n'est pas déjà ouverte — en mode Halo elle montre déjà certaines
/// informations en direct sur la pastille, une bulle en plus ferait doublon.
pub fn notify_capsule(
    app: &tauri::AppHandle,
    payload: serde_json::Value,
    only_when_closed: bool,
) {
    if only_when_closed && app.get_webview_window(ISLAND_LABEL).is_some() {
        return;
    }
    push_notification(app, payload);
}

/// Fait exister la capsule (en pastille) sans y pousser de notification.
///
/// L'activité d'un agent — ses appels d'outils — passe par `app.emit`, qui
/// n'atteint que les fenêtres OUVERTES : hors mode Halo, la capsule n'existant
/// pas, on ne voyait que le compte rendu final (poussé par `notify_capsule`) et
/// jamais le travail en cours. On l'ouvre donc dès le premier appel d'outil ;
/// island.js la referme d'elle-même quand plus rien ne tourne.
pub fn ensure_capsule(app: &tauri::AppHandle) {
    if app.get_webview_window(ISLAND_LABEL).is_some() {
        return;
    }
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(win) = ensure_island_window(&app) {
            position_halo_window(&win);
            let _ = win.show();
            halo_raise(&win);
        }
    });
}

/// Publie une entrée du **centre de notifications** : la cloche (évènement
/// `heartbeat-result`, écouté par la barre, le bureau et la capsule) et, si la
/// capsule n'existe pas encore, une bulle flottante pour que la notification
/// reste visible même sans le mode Halo.
pub fn emit_center(app: &tauri::AppHandle, payload: serde_json::Value) {
    let _ = app.emit("heartbeat-result", payload.clone());
    if app.get_webview_window(ISLAND_LABEL).is_some() {
        return; // déjà servie par l'évènement ci-dessus
    }
    let success = payload
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    push_notification(
        app,
        serde_json::json!({
            "kind": if success { "success" } else { "error" },
            "title": payload.get("shortcut").and_then(|v| v.as_str()).unwrap_or("Lumen"),
            "body": payload.get("output").and_then(|v| v.as_str()).unwrap_or(""),
            // App concernée (ouverte au clic sur la capsule), quand l'émetteur
            // la nomme.
            "app": payload.get("app").and_then(|v| v.as_str()).unwrap_or(""),
            "source": "center",
        }),
    );
}

/// Émet une notification depuis la WebView principale (test / usage interne).
#[tauri::command]
fn notify_island(app: tauri::AppHandle, payload: serde_json::Value) {
    push_notification(&app, payload);
}

/// Open an external URL or URL scheme with macOS `open` (iCloud shortcut import
/// links, `x-apple.systempreferences:` deep-links, etc.).
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    Command::new("open")
        .arg(&url)
        .status()
        .map_err(|e| format!("Impossible d'ouvrir l'URL : {}", e))
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err("`open` a échoué".into())
            }
        })
}

/// Return the names of the user's installed macOS Shortcuts (for detection).
#[tauri::command]
fn list_shortcuts() -> Result<Vec<String>, String> {
    let output = Command::new("shortcuts")
        .arg("list")
        .output()
        .map_err(|e| format!("Impossible de lister les raccourcis : {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
async fn call_macos_shortcut(shortcut_name: String, prompt: String) -> Result<String, String> {
    // `shortcuts run`'s `-i`/`--input-path` flag expects a *file path*, not raw text.
    // Passing text directly happens to work for short/simple strings but fails for
    // longer or multi-line input ("L'entrée du raccourci n'a pas pu être traitée").
    // So we write the prompt to a temp file and pass its path instead.
    // Fichier temporaire **unique par appel** : sinon des appels concurrents
    // (lecture vocale + heartbeat + dictée + génération) partageraient le même
    // chemin et s'écraseraient/supprimeraient mutuellement, coupant par exemple
    // la synthèse vocale en cours.
    let uniq = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut tmp_path = std::env::temp_dir();
    tmp_path.push(format!(
        "liquid_agent_input_{}_{}.txt",
        std::process::id(),
        uniq
    ));

    std::fs::write(&tmp_path, prompt.as_bytes())
        .map_err(|e| format!("Impossible d'écrire l'entrée du raccourci : {}", e))?;

    let output = Command::new("shortcuts")
        .args(&["run", &shortcut_name, "-i"])
        .arg(&tmp_path)
        .output();

    // Best-effort cleanup of the temp file.
    let _ = std::fs::remove_file(&tmp_path);

    match output {
        Ok(out) => {
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
            }
        }
        Err(e) => Err(format!("Impossible de lancer le raccourci : {}", e)),
    }
}

// ===== Heartbeat : déclencheur programmé (équivalent CRON pour Rust) =====
//
// Le heartbeat exécute un raccourci macOS à intervalle régulier, défini par une
// expression CRON (6 champs : `sec min heure jour mois jour-semaine`). À
// l'utilisateur de placer le process qu'il souhaite dans ce raccourci.
//
// On garde un unique `JobScheduler` actif dans l'état Tauri. Reconfigurer le
// heartbeat arrête l'ancien planificateur et en démarre un neuf.
#[derive(Default)]
struct HeartbeatState {
    scheduler: Mutex<Option<JobScheduler>>,
    /// Garde-fou anti-réentrance : `true` tant qu'un tick s'exécute et n'a pas
    /// rendu son `stdout`. Empêche Lumen de lancer un second heartbeat avant la
    /// fin du précédent. Logique 100 % Lumen, indépendante du MemoryStore.
    in_flight: Arc<AtomicBool>,
}

#[derive(Default)]
struct WorkflowSchedulerState {
    scheduler: Mutex<Option<JobScheduler>>,
}

/// Résultat d'un tick du heartbeat, émis vers le frontend (évènement
/// `heartbeat-result`) pour alimenter le centre de notifications.
#[derive(Clone, Serialize)]
struct HeartbeatResult {
    shortcut: String,
    output: String,
    success: bool,
    timestamp: u64, // epoch millisecondes
}

/// Exécute un raccourci macOS et récupère sa sortie. Utilisé par le tick du
/// heartbeat. L'entrée est optionnelle (passée via un fichier temporaire, comme
/// `call_macos_shortcut`).
fn run_shortcut_capture(shortcut_name: &str, input: &str) -> HeartbeatResult {
    let mut cmd = Command::new("shortcuts");
    cmd.arg("run").arg(shortcut_name);

    let mut tmp_path = None;
    if !input.is_empty() {
        let mut p = std::env::temp_dir();
        p.push(format!("liquid_agent_heartbeat_{}.txt", std::process::id()));
        if std::fs::write(&p, input.as_bytes()).is_ok() {
            cmd.arg("-i").arg(&p);
            tmp_path = Some(p);
        }
    }

    let result = cmd.output();
    if let Some(p) = tmp_path {
        let _ = std::fs::remove_file(p);
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let (output, success) = match result {
        Ok(out) => {
            if out.status.success() {
                (
                    String::from_utf8_lossy(&out.stdout).trim().to_string(),
                    true,
                )
            } else {
                (
                    String::from_utf8_lossy(&out.stderr).trim().to_string(),
                    false,
                )
            }
        }
        Err(e) => (format!("Impossible de lancer le raccourci : {}", e), false),
    };

    HeartbeatResult {
        shortcut: shortcut_name.to_string(),
        output,
        success,
        timestamp,
    }
}

/// Tick Heartbeat en mode Fluxo : exécute le workflow verrouillé « Heartbeat »
/// (réceptacle, comme le raccourci Apple) et produit un HeartbeatResult.
fn run_fluxo_heartbeat(app: &tauri::AppHandle, input: &str) -> HeartbeatResult {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let wf = load_fluxo_workflows(app)
        .into_iter()
        .find(|w| w.name == "Heartbeat");
    let (output, success) = match wf {
        Some(wf) => {
            let r = fluxo_engine_for(app).run_with_input(&wf, FluxoValue::Text(input.to_string()));
            if r.success {
                (r.output.as_text(), true)
            } else {
                let msg = r
                    .steps
                    .iter()
                    .rev()
                    .find_map(|s| s.error.clone())
                    .unwrap_or_else(|| "échec".into());
                (msg, false)
            }
        }
        None => ("Workflow Fluxo « Heartbeat » introuvable".into(), false),
    };

    HeartbeatResult {
        shortcut: "Heartbeat (Fluxo)".into(),
        output,
        success,
        timestamp,
    }
}

/// Démarre (ou redémarre) le heartbeat avec une expression CRON donnée.
/// `engine` vaut `"fluxo"` (workflow Fluxo) ou `"shortcut"` (raccourci macOS).
#[tauri::command]
async fn start_heartbeat(
    app: tauri::AppHandle,
    state: tauri::State<'_, HeartbeatState>,
    shortcut_name: String,
    cron: String,
    input: String,
    engine: String,
) -> Result<(), String> {
    // Arrête un éventuel planificateur déjà en cours.
    {
        let mut guard = state.scheduler.lock().await;
        if let Some(mut sched) = guard.take() {
            let _ = sched.shutdown().await;
        }
    }
    // Repart d'un garde-fou libre (un ancien tick interrompu ne doit pas bloquer).
    state.in_flight.store(false, AtomicOrdering::SeqCst);

    let sched = JobScheduler::new()
        .await
        .map_err(|e| format!("Impossible de créer le planificateur : {}", e))?;

    let in_flight = state.in_flight.clone();

    let job = Job::new_async(cron.as_str(), move |_uuid, _lock| {
        let sc = shortcut_name.clone();
        let inp = input.clone();
        let app = app.clone();
        let eng = engine.clone();
        let in_flight = in_flight.clone();
        Box::pin(async move {
            // Garde-fou : si un tick précédent n'a pas encore rendu son stdout,
            // on saute celui-ci (jamais deux exécutions en parallèle). `swap`
            // pose le drapeau atomiquement : si l'ancienne valeur était déjà
            // `true`, un tick tourne encore → on signale et on sort.
            if in_flight.swap(true, AtomicOrdering::SeqCst) {
                let _ = app.emit("heartbeat-skipped", ());
                return;
            }

            // Signale le déclenchement au frontend (pulsation du cœur dans l'orbe),
            // AVANT l'exécution bloquante du raccourci/workflow.
            let _ = app.emit("heartbeat-tick", ());
            // L'exécution est bloquante (raccourci ou moteur Fluxo) : hors runtime async.
            let app_run = app.clone();
            let res = tokio::task::spawn_blocking(move || {
                if eng == "fluxo" {
                    run_fluxo_heartbeat(&app_run, &inp)
                } else {
                    run_shortcut_capture(&sc, &inp)
                }
            })
            .await;
            // Le stdout est revenu (ou la tâche a échoué) : on libère le garde-fou
            // pour autoriser le prochain tick, AVANT d'émettre le résultat.
            in_flight.store(false, AtomicOrdering::SeqCst);
            // On transmet le résultat au frontend (centre de notifications).
            if let Ok(result) = res {
                emit_center(&app, serde_json::to_value(&result).unwrap_or_default());
            }
        })
    })
    .map_err(|e| format!("Expression CRON invalide : {}", e))?;

    sched
        .add(job)
        .await
        .map_err(|e| format!("Impossible d'ajouter la tâche : {}", e))?;
    sched
        .start()
        .await
        .map_err(|e| format!("Impossible de démarrer le planificateur : {}", e))?;

    *state.scheduler.lock().await = Some(sched);
    Ok(())
}

/// Arrête le heartbeat s'il est actif.
#[tauri::command]
async fn stop_heartbeat(state: tauri::State<'_, HeartbeatState>) -> Result<(), String> {
    let mut guard = state.scheduler.lock().await;
    if let Some(mut sched) = guard.take() {
        sched
            .shutdown()
            .await
            .map_err(|e| format!("Impossible d'arrêter le planificateur : {}", e))?;
    }
    state.in_flight.store(false, AtomicOrdering::SeqCst);
    Ok(())
}

// ===== Accès à Fluxo (backend d'automatisation) =====
//
// Lumen lit les workflows enregistrés par l'app Fluxo et les exécute via le
// moteur partagé `fluxo-engine`. Les deux apps partagent le même répertoire
// parent de données (Application Support / AppData) : on dérive donc le dossier
// de Fluxo depuis celui de Lumen en remplaçant l'identifiant.

fn fluxo_workflows_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let lumen_dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    let parent = lumen_dir
        .parent()
        .ok_or_else(|| "Dossier de données introuvable".to_string())?;
    Ok(parent.join("com.lumen.fluxo").join("workflows"))
}

/// Nom du workflow routeur par défaut (équivalent Fluxo du « Action Router »
/// d'Apple). En mode Action + Ollama, toute requête sans workflow spécifique y
/// est envoyée.
const FLUXO_ROUTER_NAME: &str = "default router";

/// Contenu du workflow routeur par défaut, semé si absent. Il appelle le modèle
/// Ollama sélectionné (variables `{{model}}` / `{{ollama_url}}` injectées par
/// Lumen), pousse sa progression dans la bulle, et renvoie la réponse. C'est un
/// squelette : l'utilisateur peut l'enrichir dans Fluxo (conditions, sous-
/// workflows) pour router vers ses propres automatisations.
const FLUXO_ROUTER_JSON: &str = r#"{
  "name": "default router",
  "locked": false,
  "trigger": { "type": "manual" },
  "steps": [
    { "id": "p1", "action": "lumen_progress", "params": { "message": { "type": "text", "value": "Routage de la demande via {{model}}…" }, "kind": { "type": "text", "value": "step" } } },
    { "id": "gen", "action": "ollama_generate", "params": { "prompt": { "type": "text", "value": "{{input}}" }, "system": { "type": "text", "value": "Tu es le routeur d'actions de Lumen, un agent local et privé. Analyse la demande et réponds de façon concise, claire et actionnable, dans la langue de la demande." }, "model": { "type": "text", "value": "{{model}}" }, "url": { "type": "text", "value": "{{ollama_url}}" } } }
  ]
}"#;

/// Garantit la présence du routeur par défaut **déverrouillé**. Best-effort :
/// n'échoue jamais le démarrage.
///   • absent          → écrit le gabarit (déverrouillé) ;
///   • présent + locked → migration : déverrouille sur place (préserve les pas) ;
///   • présent + éditable → ne touche à rien (respecte les personnalisations).
/// Le déverrouillage est nécessaire car le backend Fluxo refuse d'écraser ou de
/// supprimer un workflow verrouillé — sans ça, même le bouton « Réinitialiser »
/// échouerait.
fn ensure_default_router(app: &tauri::AppHandle) {
    let Ok(dir) = fluxo_workflows_dir(app) else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    // Cherche un fichier dont le workflow s'appelle « default router ».
    let existing = std::fs::read_dir(&dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .find_map(|e| {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                return None;
            }
            let txt = std::fs::read_to_string(&path).ok()?;
            let wf = FluxoWorkflow::from_json(&txt).ok()?;
            (wf.name == FLUXO_ROUTER_NAME).then_some((path, wf))
        });

    match existing {
        // Présent mais verrouillé : on le déverrouille en conservant ses étapes.
        Some((path, mut wf)) if wf.locked => {
            wf.locked = false;
            if let Ok(json) = wf.to_json() {
                let _ = std::fs::write(path, json);
            }
        }
        // Présent et déjà éditable : rien à faire.
        Some(_) => {}
        // Absent : on sème le gabarit (déjà déverrouillé).
        None => {
            let _ = std::fs::write(dir.join("default-router.json"), FLUXO_ROUTER_JSON);
        }
    }
}

/// Charge tous les workflows Fluxo enregistrés.
fn load_fluxo_workflows(app: &tauri::AppHandle) -> Vec<FluxoWorkflow> {
    let mut out = Vec::new();
    if let Ok(dir) = fluxo_workflows_dir(app) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                if e.path().extension().and_then(|s| s.to_str()) == Some("json") {
                    if let Ok(txt) = std::fs::read_to_string(e.path()) {
                        if let Ok(wf) = FluxoWorkflow::from_json(&txt) {
                            out.push(wf);
                        }
                    }
                }
            }
        }
    }
    out
}

/// Moteur Fluxo configuré avec le résolveur de sous-workflows (bloc « Exécuter
/// un workflow ») pointant sur les workflows partagés.
fn fluxo_engine_for(app: &tauri::AppHandle) -> Engine {
    let mut engine = Engine::with_builtins();
    engine.register(std::sync::Arc::new(WorkflowSpeakAction { app: app.clone() }));
    let app2 = app.clone();
    engine.set_resolver(move |name| {
        load_fluxo_workflows(&app2)
            .into_iter()
            .find(|w| w.name == name)
    });
    engine
}

/// Action hôte pour permettre à Fluxo d'utiliser le même catalogue vocal que
/// Lumen (voix système, Piper et Kokoro), sans exposer Tauri au crate moteur.
struct WorkflowSpeakAction { app: tauri::AppHandle }
impl FluxoAction for WorkflowSpeakAction {
    fn spec(&self) -> FluxoActionSpec {
        FluxoActionSpec {
            id: "speak".into(), name: "Énoncer le texte".into(),
            description: "Lit un texte avec le moteur vocal choisi (système, Piper ou Kokoro).".into(),
            category: "Système".into(), icon: "volume-2".into(), produces_output: false,
            params: vec![
                FluxoParamSpec::new("text", "Texte", FluxoParamKind::Multiline).placeholder("{{input}}"),
                FluxoParamSpec::new("backend", "Moteur vocal", FluxoParamKind::Select { options: vec!["system".into(), "piper".into(), "kokoro".into()] }).placeholder("system, piper ou kokoro"),
                FluxoParamSpec::new("voice", "Voix", FluxoParamKind::Text).placeholder("Voix installée (vide = défaut)"),
            ],
        }
    }
    fn run(&self, params: &BTreeMap<String, FluxoValue>, _ctx: &mut FluxoExecContext) -> anyhow::Result<FluxoValue> {
        let text = params.get("text").map(|v| v.as_text()).unwrap_or_default();
        let backend = params.get("backend").map(|v| v.as_text()).unwrap_or_else(|| "system".into());
        let voice = params.get("voice").map(|v| v.as_text()).filter(|v| !v.trim().is_empty());
        if backend == "system" {
            fluxo_engine::actions::speak_system_text_lang_voice(&text, None, voice.as_deref())?;
        } else {
            self::tts::tts_speak_workflow(self.app.clone(), text, voice)
                .map_err(|e| anyhow::anyhow!(e))?;
        }
        Ok(FluxoValue::Bool(true))
    }
}

/// Noms des workflows Fluxo disponibles (pour les proposer dans Lumen).
#[tauri::command]
fn list_fluxo_workflows(app: tauri::AppHandle) -> Vec<String> {
    let mut names: Vec<String> = load_fluxo_workflows(&app)
        .into_iter()
        .map(|w| w.name)
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names
}

/// Workflows **exposés au function calling** (`available_as_tool`), et eux seuls.
///
/// `list_fluxo_workflows` renvoie TOUT : c'est ce qu'il faut pour les listes de
/// l'interface (designer, sélecteur de skills, mode « workflow »), mais pas pour
/// construire le catalogue d'outils d'un modèle. La barre et le bureau
/// s'appuyaient dessus et présentaient donc au modèle jusqu'aux workflows
/// explicitement retirés dans le designer — l'inverse de la règle annoncée par
/// le bouton (« moins d'outils = appels plus précis »), et du comportement des
/// agents, qui filtrent depuis toujours (cf. `agents::build_tools`).
#[tauri::command]
fn list_fluxo_tool_workflows(app: tauri::AppHandle) -> Vec<String> {
    let mut names: Vec<String> = load_fluxo_workflows(&app)
        .into_iter()
        .filter(|w| w.available_as_tool)
        .map(|w| w.name)
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names
}

/// Exécute un workflow Fluxo par son nom, avec une entrée optionnelle (ex. le
/// texte du chat), et renvoie la sortie finale en texte.
///
/// Commande **synchrone** : Tauri l'exécute hors du runtime async, ce qui permet
/// au moteur Fluxo d'utiliser ses appels bloquants (HTTP, script) sans paniquer.
// Asynchrone + `spawn_blocking` : certains workflows (ex. « Dicter le texte »
// qui enregistre 6 s de micro puis transcrit avec Whisper) bloquent plusieurs
// secondes. Une commande synchrone s'exécuterait sur le thread principal et
// gèlerait toute l'UI ; on déporte donc l'exécution hors du thread principal.
#[tauri::command]
async fn run_fluxo_workflow(
    app: tauri::AppHandle,
    name: String,
    input: String,
    run_id: Option<String>,
    extra_vars: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    // Le serveur loopback doit tourner : les blocs de retour Fluxo (notification,
    // widget, progression, mémoire) y POSTent. Idempotent.
    ensure_loopback_server(&app).await;
    // Le chat peut utiliser llama-server ou une API cloud tandis que les blocs
    // historiques s'appellent encore `ollama_*`. Réinjecte le backend réellement
    // actif avant chaque run afin qu'ils suivent exactement la configuration Lumen.
    agents::export_llm_env(&app);

    tauri::async_runtime::spawn_blocking(move || {
        // URL du serveur loopback lue par le pont Lumen des blocs Fluxo. Valeur
        // statique (port fixe) → l'env convient, sans course entre runs.
        std::env::set_var(
            "LUMEN_URL",
            format!("http://127.0.0.1:{}", companion::LOCAL_PORT),
        );

        let wf = load_fluxo_workflows(&app)
            .into_iter()
            .find(|w| w.name == name)
            .ok_or_else(|| format!("Workflow Fluxo « {name} » introuvable"))?;

        // Le run courant est injecté comme variable de contexte : exposé en
        // {{run_id}} dans le workflow et lu par défaut par les blocs de retour.
        // Pas d'env partagé → sûr même si plusieurs runs s'exécutaient.
        let mut vars = std::collections::BTreeMap::new();
        vars.insert(
            "run_id".to_string(),
            FluxoValue::Text(run_id.unwrap_or_else(|| "fluxo".to_string())),
        );
        // Variables additionnelles fournies par l'appelant (ex. le routeur reçoit
        // `model` et `ollama_url` pour interroger le bon modèle local).
        if let Some(extra) = extra_vars {
            for (k, v) in extra {
                vars.insert(k, FluxoValue::Text(v));
            }
        }
        let result = fluxo_engine_for(&app).run_with_vars(&wf, FluxoValue::Text(input), vars);
        if result.success {
            Ok(result.output.as_text())
        } else {
            let msg = result
                .steps
                .iter()
                .rev()
                .find_map(|s| s.error.clone())
                .unwrap_or_else(|| "échec inconnu".into());
            Err(format!("Échec du workflow : {msg}"))
        }
    })
    .await
    .map_err(|e| format!("Tâche interrompue : {e}"))?
}

/// Énonce un texte avec la synthèse vocale système. Utilisé par l'UI Mac en mode
/// Ollama pour éviter de relancer un workflow complet juste pour parler.
#[tauri::command]
async fn system_speak(text: String, lang: Option<String>, voice: Option<String>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fluxo_engine::actions::speak_system_text_lang_voice(&text, lang.as_deref(), voice.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Tâche interrompue : {e}"))?
}

/// Retourne les voix installées du moteur vocal système pour les sélecteurs de
/// workflows. Sur macOS, `say -v '?'` est la source officielle ; les autres
/// plateformes renvoient une liste vide et conservent la saisie libre.
#[tauri::command]
fn system_voice_list() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let Ok(out) = std::process::Command::new("say").args(["-v", "?"]).output() else { return Vec::new(); };
        let listing = String::from_utf8_lossy(&out.stdout);
        let mut voices = Vec::new();
        for line in listing.lines() {
            let words: Vec<&str> = line.split_whitespace().collect();
            let Some(idx) = words.iter().position(|word| {
                let bytes = word.as_bytes();
                bytes.len() >= 2 && bytes[0].is_ascii_lowercase() && bytes[1].is_ascii_lowercase()
                    && (bytes.len() == 2 || bytes.get(2) == Some(&b'_') || bytes.get(2) == Some(&b'-'))
            }) else { continue; };
            if idx > 0 { voices.push(words[..idx].join(" ")); }
        }
        voices.sort();
        voices.dedup();
        voices
    }
    #[cfg(not(target_os = "macos"))]
    { Vec::new() }
}

/// Interrompt toute lecture vocale en cours (voix système say/PowerShell/spd-say
/// ET synthèse locale Piper). Utilisé par le bouton 🔊 du chat qui bascule
/// lecture/arrêt.
#[tauri::command]
fn stop_speaking(state: tauri::State<'_, tts::TtsState>) -> Result<(), String> {
    fluxo_engine::actions::stop_system_speech();
    let _ = tts::tts_stop(state);
    Ok(())
}

// ===== Designer Fluxo intégré =====
// Le designer (éditeur de workflows) est embarqué dans Lumen et ouvert dans une
// fenêtre dédiée. Ses commandes Tauri portent les mêmes noms que celles de l'app
// Fluxo (le frontend du designer est copié tel quel), mais opèrent ici sur le
// dossier de workflows PARTAGÉ et le moteur déjà linké dans Lumen.

/// Slug de nom de fichier, identique à celui de l'app Fluxo : garantit qu'un
/// workflow édité dans Lumen écrit le même fichier que s'il l'était dans Fluxo.
fn fluxo_slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = s.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "workflow".into()
    } else {
        trimmed
    }
}

/// Retrouve le fichier d'un workflow par son nom (les verrouillés peuvent avoir
/// un nom de fichier dédié → on lit le contenu plutôt que de se fier au slug).
fn fluxo_find_file(app: &tauri::AppHandle, name: &str) -> Option<(PathBuf, FluxoWorkflow)> {
    let dir = fluxo_workflows_dir(app).ok()?;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        if e.path().extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok(txt) = std::fs::read_to_string(e.path()) {
                if let Ok(wf) = FluxoWorkflow::from_json(&txt) {
                    if wf.name == name {
                        return Some((e.path(), wf));
                    }
                }
            }
        }
    }
    None
}

/// Métadonnées d'un workflow pour la liste du designer.
#[derive(Serialize)]
struct FluxoWorkflowMeta {
    name: String,
    locked: bool,
}

/// Catalogue des actions disponibles (bibliothèque du designer).
#[tauri::command]
fn list_actions(app: tauri::AppHandle) -> Vec<FluxoActionSpec> {
    fluxo_engine_for(&app).specs()
}

/// Liste des workflows (nom + verrou), verrouillés en tête.
#[tauri::command]
fn list_workflows(app: tauri::AppHandle) -> Result<Vec<FluxoWorkflowMeta>, String> {
    let mut metas: Vec<FluxoWorkflowMeta> = load_fluxo_workflows(&app)
        .into_iter()
        .map(|w| FluxoWorkflowMeta {
            name: w.name,
            locked: w.locked,
        })
        .collect();
    metas.sort_by(|a, b| {
        b.locked
            .cmp(&a.locked)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(metas)
}

/// Charge un workflow par son nom.
#[tauri::command]
fn load_workflow(app: tauri::AppHandle, name: String) -> Result<FluxoWorkflow, String> {
    fluxo_find_file(&app, &name)
        .map(|(_, wf)| wf)
        .ok_or_else(|| format!("Workflow « {name} » introuvable"))
}

/// Enregistre un workflow (refuse d'écraser un workflow verrouillé).
#[tauri::command]
fn save_workflow(app: tauri::AppHandle, workflow: FluxoWorkflow) -> Result<(), String> {
    if let Some((_, existing)) = fluxo_find_file(&app, &workflow.name) {
        if existing.locked {
            return Err("Ce workflow est verrouillé et ne peut pas être modifié.".into());
        }
    }
    let dir = fluxo_workflows_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", fluxo_slug(&workflow.name)));
    let json = workflow.to_json().map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Supprime un workflow (refuse les verrouillés).
#[tauri::command]
fn delete_workflow(app: tauri::AppHandle, name: String) -> Result<(), String> {
    match fluxo_find_file(&app, &name) {
        Some((_, wf)) if wf.locked => {
            Err("Ce workflow est verrouillé et ne peut pas être supprimé.".into())
        }
        Some((path, _)) => std::fs::remove_file(path).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Exécute le workflow en cours d'édition (bouton « Exécuter » du designer), avec
/// une entrée de test optionnelle exposée via `{{input}}`.
#[tauri::command]
async fn run_workflow(
    app: tauri::AppHandle,
    workflow: FluxoWorkflow,
    input: Option<String>,
) -> Result<FluxoRunResult, String> {
    // Les blocs de retour Fluxo (notification, progression…) POSTent sur le
    // serveur loopback : on s'assure qu'il tourne, comme pour run_fluxo_workflow.
    ensure_loopback_server(&app).await;
    // Les fenêtres Tauri ont des localStorage distincts ; la source de vérité
    // persistée côté Rust garantit que le designer utilise le même backend que
    // le chat (Ollama, llama.cpp intégré ou API cloud).
    agents::export_llm_env(&app);

    tauri::async_runtime::spawn_blocking(move || {
        std::env::set_var(
            "LUMEN_URL",
            format!("http://127.0.0.1:{}", companion::LOCAL_PORT),
        );
        let engine = fluxo_engine_for(&app);
        let result = match input {
            Some(text) => engine.run_with_input(&workflow, FluxoValue::Text(text)),
            None => engine.run(&workflow),
        };
        Ok(result)
    })
    .await
    .map_err(|e| format!("Tâche interrompue : {e}"))?
}

/// Un badge vient d'être posé sur le lecteur du Lumen Controller : lance les
/// workflows dont le déclencheur est « Badge RFID ».
///
/// L'UID devient l'ENTRÉE du workflow (`{{input}}`) : un déclencheur sans UID
/// (« n'importe quel badge ») peut donc aiguiller lui-même, et un déclencheur
/// ciblé garde quand même l'information sous la main.
///
/// Appelé depuis le pont TCP (`orb_bridge`), pas depuis une webview : les
/// automatisations par badge tournent même sans fenêtre ouverte.
pub(crate) fn dispatch_rfid_triggers(app: &tauri::AppHandle, uid: String) {
    let workflows: Vec<FluxoWorkflow> = load_fluxo_workflows(app)
        .into_iter()
        .filter(|w| match &w.trigger {
            // UID vide = n'importe quel badge. Sinon, correspondance exacte sur
            // l'UID normalisé (les lecteurs l'écrivent avec ou sans séparateur).
            Some(FluxoTrigger::Rfid { uid: wanted }) => {
                let wanted: String = wanted
                    .chars()
                    .filter(|c| c.is_ascii_hexdigit())
                    .flat_map(|c| c.to_uppercase())
                    .collect();
                wanted.is_empty() || wanted == uid
            }
            _ => false,
        })
        .collect();
    if workflows.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Les blocs de retour Fluxo (notification, progression…) passent par le
        // serveur loopback : même précaution que pour un run manuel.
        ensure_loopback_server(&app).await;
        agents::export_llm_env(&app);
        for workflow in workflows {
            let name = workflow.name.clone();
            let app_run = app.clone();
            let uid = uid.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                std::env::set_var(
                    "LUMEN_URL",
                    format!("http://127.0.0.1:{}", companion::LOCAL_PORT),
                );
                fluxo_engine_for(&app_run).run_with_input(&workflow, FluxoValue::Text(uid))
            })
            .await;
            let payload = match result {
                Ok(result) => serde_json::json!({
                    "workflow": name, "trigger": "rfid", "success": result.success,
                    "output": result.output.as_text(),
                }),
                Err(error) => serde_json::json!({
                    "workflow": name, "trigger": "rfid", "success": false,
                    "output": error.to_string(),
                }),
            };
            let _ = app.emit("workflow-triggered", payload);
        }
    });
}

/// Événement nommé par un chemin (« iphone/arrivee/maison », « vault/courses »)
/// → lance les workflows dont le déclencheur Webhook porte ce chemin. Un
/// chemin qui finit par « * » attrape tout ce qui commence pareil
/// (« iphone/* »). `input` (JSON de l'événement) devient `{{input}}`.
///
/// Réutilise le déclencheur Webhook existant du moteur : l'iPhone (lieux,
/// concentration, NFC…) et le coffre de données n'ont pas besoin d'un
/// nouveau type de déclencheur dans Fluxo.
pub(crate) fn dispatch_path_triggers(app: &tauri::AppHandle, path: String, input: String) {
    let wanted = path.trim_matches('/').to_lowercase();
    let workflows: Vec<FluxoWorkflow> = load_fluxo_workflows(app)
        .into_iter()
        .filter(|w| match &w.trigger {
            Some(FluxoTrigger::Webhook { path: p }) => {
                let p = p.trim_matches('/').to_lowercase();
                match p.strip_suffix('*') {
                    Some(prefix) => wanted.starts_with(prefix.trim_end_matches('/')),
                    None => p == wanted,
                }
            }
            _ => false,
        })
        .collect();
    if workflows.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        ensure_loopback_server(&app).await;
        agents::export_llm_env(&app);
        for workflow in workflows {
            let name = workflow.name.clone();
            let app_run = app.clone();
            let input = input.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                std::env::set_var("LUMEN_URL", format!("http://127.0.0.1:{}", companion::LOCAL_PORT));
                fluxo_engine_for(&app_run).run_with_input(&workflow, FluxoValue::Text(input))
            })
            .await;
            let (success, output) = match result {
                Ok(r) => (r.success, r.output.as_text()),
                Err(e) => (false, e.to_string()),
            };
            record_workflow_run(&app, &name, "event", success, &output);
            let _ = app.emit("workflow-triggered", serde_json::json!({ "workflow": name, "trigger": wanted, "success": success, "output": output }));
        }
    });
}

/// Reconstruit tous les jobs CRON des workflows enregistrés. Le moteur garde les
/// workflows appelables comme tools pour les agents ; le CRON est simplement une
/// seconde porte d'entrée vers le même workflow, exécutée localement.
async fn reschedule_workflows(
    app: tauri::AppHandle,
    state: &WorkflowSchedulerState,
) -> Result<(), String> {
    {
        let mut guard = state.scheduler.lock().await;
        if let Some(mut scheduler) = guard.take() {
            let _ = scheduler.shutdown().await;
        }
    }
    let scheduler = JobScheduler::new().await.map_err(|e| e.to_string())?;
    for workflow in load_fluxo_workflows(&app) {
        let Some(FluxoTrigger::Cron { expr }) = workflow.trigger.clone() else { continue; };
        if expr.trim().is_empty() { continue; }
        let scheduled_name = workflow.name.clone();
        let scheduled_expr = expr.clone();
        let scheduled_app = app.clone();
        let job = Job::new_async(expr.as_str(), move |_id, _lock| {
            let app = scheduled_app.clone();
            let name = scheduled_name.clone();
            let expr = scheduled_expr.clone();
            Box::pin(async move {
                // Le workflow est RELU au moment de tirer : supprimé ou
                // reprogrammé entre-temps (app Tâches planifiées), le job
                // capturé ne doit pas rejouer une version fantôme.
                let Some((path, workflow)) = fluxo_find_file(&app, &name) else { return; };
                if !matches!(&workflow.trigger, Some(FluxoTrigger::Cron { expr: e }) if e.trim() == expr.trim()) { return; }
                // Tâche ponctuelle (marqueur « [once] » posé par l'app Tâches
                // planifiées) : croner n'a pas de champ année, une date fixe
                // reviendrait chaque année — on retire le workflow après coup.
                let one_shot = workflow.description.contains("[once]");
                let app_run = app.clone();
                let result = tokio::task::spawn_blocking(move || fluxo_engine_for(&app_run).run(&workflow)).await;
                let (success, output) = match result {
                    Ok(result) => (result.success, result.output.as_text()),
                    Err(error) => (false, error.to_string()),
                };
                // Journal des exécutions planifiées : sans lui, une tâche qui
                // tourne la nuit ne laisse aucune trace consultable (l'app
                // Tâches planifiées l'affiche, la notification est volatile).
                record_workflow_run(&app, &name, "cron", success, &output);
                if one_shot {
                    let _ = std::fs::remove_file(&path);
                    let _ = app.emit("workflows-changed", serde_json::json!({ "removed": name }));
                }
                let _ = app.emit("workflow-triggered", serde_json::json!({
                    "workflow": name, "trigger": "cron", "success": success, "output": output,
                }));
            })
        }).map_err(|e| format!("CRON invalide pour « {} » : {e}", workflow.name))?;
        scheduler.add(job).await.map_err(|e| e.to_string())?;
    }
    scheduler.start().await.map_err(|e| e.to_string())?;
    *state.scheduler.lock().await = Some(scheduler);
    Ok(())
}

/// Expose les workflows CRON pour le Calendrier et l'app Tâches planifiées. Le
/// calcul des occurrences est volontairement fait par l'UI, qui connaît la
/// période affichée. Les champs au-delà de `name`/`expr` servent à l'app Tâches
/// planifiées (nature de la tâche, verrou, auteur) — le Calendrier les ignore.
#[tauri::command]
fn list_workflow_schedules(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    load_fluxo_workflows(&app).into_iter().filter_map(|workflow| {
        match workflow.trigger {
            Some(FluxoTrigger::Cron { expr }) if !expr.trim().is_empty() => Some(serde_json::json!({
                "name": workflow.name, "expr": expr,
                "description": workflow.description, "locked": workflow.locked,
                "created_by": workflow.created_by,
                "actions": workflow.steps.iter().map(|s| s.action.clone()).collect::<Vec<_>>(),
            })),
            _ => None,
        }
    }).collect()
}

/// Journal des exécutions planifiées (`workflow-runs.json`, 300 entrées max).
fn workflow_runs_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = crate::paths::shared_data_dir(app.path()).ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("workflow-runs.json"))
}

fn record_workflow_run(app: &tauri::AppHandle, name: &str, trigger: &str, success: bool, output: &str) {
    let Some(path) = workflow_runs_path(app) else { return };
    let mut runs: Vec<serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    // Sortie bornée : une réponse de modèle peut faire des pages, le journal
    // doit rester léger à relire.
    let excerpt: String = output.chars().take(4000).collect();
    runs.push(serde_json::json!({
        "workflow": name, "trigger": trigger, "success": success, "output": excerpt, "at": ts,
    }));
    if runs.len() > 300 {
        let drop = runs.len() - 300;
        runs.drain(0..drop);
    }
    let _ = std::fs::write(&path, serde_json::to_string(&runs).unwrap_or_else(|_| "[]".into()));
}

/// Exécutions planifiées, de la plus récente à la plus ancienne.
#[tauri::command]
fn list_workflow_runs(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let mut runs: Vec<serde_json::Value> = workflow_runs_path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    runs.reverse();
    runs
}

/// Exécution manuelle d'un workflow depuis l'app Tâches planifiées : même
/// chemin que le CRON, et l'exécution est journalisée de la même façon.
#[tauri::command]
async fn run_scheduled_workflow(app: tauri::AppHandle, name: String) -> Result<serde_json::Value, String> {
    ensure_loopback_server(&app).await;
    agents::export_llm_env(&app);
    let Some((_, workflow)) = fluxo_find_file(&app, &name) else {
        return Err(format!("Workflow « {name} » introuvable"));
    };
    let app_run = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        std::env::set_var("LUMEN_URL", format!("http://127.0.0.1:{}", companion::LOCAL_PORT));
        fluxo_engine_for(&app_run).run(&workflow)
    })
    .await
    .map_err(|e| format!("Tâche interrompue : {e}"))?;
    let output = result.output.as_text();
    record_workflow_run(&app, &name, "manual", result.success, &output);
    Ok(serde_json::json!({ "success": result.success, "output": output }))
}

#[tauri::command]
async fn reload_triggers(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkflowSchedulerState>,
) -> Result<(), String> {
    reschedule_workflows(app, state.inner()).await
}







/// Ouvre (ou ramène au premier plan) la fenêtre de l'explorateur de sandboxes.
#[tauri::command]
fn open_sandbox_explorer(
    app: tauri::AppHandle,
    sandbox_id: Option<String>,
    desktop: Option<bool>,
) -> Result<(), String> {
    diag_file_log(&app, "sandbox-explorer", "open_sandbox_explorer called");
    run_window_task_after_ipc(&app, "sandbox-explorer", move |app| {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        diag_file_log(&app, "sandbox-explorer", "window task started");
        // Id de sandbox à présélectionner (ex. « Ouvrir la sandbox » d'un agent).
        let id = sandbox_id.filter(|s| !s.is_empty());
        let want_desktop = desktop.unwrap_or(false);
        if let Some(win) = app.get_webview_window("sandbox-explorer") {
            diag_file_log(&app, "sandbox-explorer", "existing window found");
            let _ = win.show();
            let _ = win.set_focus();
            normalize_child_window(&win);
            // Fenêtre déjà ouverte : on demande au front de basculer sur cette sandbox.
            if let Some(id) = &id {
                let safe: String = id
                    .chars()
                    .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                    .collect();
                let _ = win.eval(&format!(
                    "window.__selectSandbox && window.__selectSandbox('{safe}')"
                ));
            }
            // Accès rapide « Bureau » depuis le HUB : on bascule en mode bureau. Le
            // workspace s'ouvre en VRAI plein écran quel que soit l'OS (immersion
            // maximale), et on maximise en repli.
            if want_desktop {
                // Garantie native immédiate : ne dépend pas du chargement ni de
                // la réception de l'événement par la WebView principale.
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.set_always_on_top(false);
                }
                let _ = app.emit("desktop-mode", serde_json::json!({ "active": true }));
                // Sous Windows, maximiser APRÈS set_fullscreen ferait sortir la
                // fenêtre du plein écran : on ne maximise qu'en repli d'échec.
                if win.set_fullscreen(true).is_err() {
                    let _ = win.maximize();
                }
                let _ = win.eval("window.__enterDesktop && window.__enterDesktop()");
            }
            return Ok(());
        }
        // Au premier lancement, on passe l'id (et le mode bureau) via la query string.
        let q = if want_desktop { "&desktop=1" } else { "" };
        let url = match &id {
            Some(id) => format!("sandbox/explorer.html?id={id}{q}"),
            None => format!("sandbox/explorer.html?{}", q.trim_start_matches('&')),
        };
        diag_file_log(&app, "sandbox-explorer", "before window build");
        // À la fermeture de la fenêtre, si le mode bureau était actif, l'orbe de la
        // fenêtre principale doit réapparaître (le `beforeunload` JS n'est pas fiable
        // à la fermeture native) : on rediffuse `desktop-mode` { active: false }.
        let app_evt = app.clone();
        // Lancé depuis la carte « Workspace » : bureau immersif d'emblée, en VRAI
        // plein écran quel que soit l'OS (maximisé en repli). ATTENTION Windows :
        // construire la fenêtre avec `.fullscreen(true)` (a fortiori combiné à
        // `.maximized(true)`) fait échouer la création du WebView2 (fenêtre blanche
        // ou absente) → on construit une fenêtre normale et on passe en plein
        // écran APRÈS le build.
        let build_fullscreen = want_desktop && !cfg!(windows);
        if want_desktop {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.set_always_on_top(false);
            }
            let _ = app.emit("desktop-mode", serde_json::json!({ "active": true }));
        }
        let win = WebviewWindowBuilder::new(&app, "sandbox-explorer", WebviewUrl::App(url.into()))
            .title("Lumen — Sandboxes")
            .inner_size(1100.0, 720.0)
            .min_inner_size(820.0, 520.0)
            .resizable(true)
            .fullscreen(build_fullscreen)
            .maximized(want_desktop && !build_fullscreen)
            // Désactive le handler de drag&drop NATIF de Tauri : sinon il intercepte
            // les évènements `dragover`/`drop` HTML5 du webview et casse le DnD du
            // sandbox (déplacement de fichiers dans les dossiers, dépôts du bureau).
            // On gère le drag&drop HTML5 nous-mêmes côté JS.
            .disable_drag_drop_handler()
            .build()
            .map_err(|e| e.to_string())?;
        diag_file_log(&app, "sandbox-explorer", "window built");
        normalize_child_window(&win);
        // Windows : plein écran appliqué après coup (cf. commentaire du builder),
        // légèrement différé pour laisser le WebView2 s'attacher à la fenêtre.
        if want_desktop && !build_fullscreen {
            let win_fs = win.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                if win_fs.set_fullscreen(true).is_err() {
                    let _ = win_fs.maximize();
                }
            });
        }
        win.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
            ) {
                let _ = app_evt.emit("desktop-mode", serde_json::json!({ "active": false }));
            }
        });
        Ok(())
    })
}



/// Accès interne (raccourcis du compagnon).
pub(crate) fn open_messenger_pub(app: tauri::AppHandle) -> Result<(), String> {
    open_messenger(app)
}
pub(crate) fn list_fluxo_workflows_pub(app: tauri::AppHandle) -> Vec<String> {
    list_fluxo_workflows(app)
}



/// Navigateur de dossiers pour choisir un dossier de modèles : noms des
/// sous-dossiers seulement (aucun contenu lu), nombre de GGUF visibles, et
/// raccourcis (dossier personnel, volumes montés). Lecture seule.
#[tauri::command]
fn fs_browse_dirs(path: Option<String>) -> Result<serde_json::Value, String> {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| "/".into());
    let dir = std::path::PathBuf::from(path.filter(|p| !p.trim().is_empty()).unwrap_or_else(|| home.clone()));
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("{} : {e}", dir.display()))?;
    let mut dirs = Vec::new();
    let mut gguf = 0usize;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            dirs.push(serde_json::json!({ "name": name, "path": p.to_string_lossy() }));
        } else if name.to_lowercase().ends_with(".gguf") {
            gguf += 1;
        }
    }
    dirs.sort_by(|a, b| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()));
    let mut roots = vec![serde_json::json!({ "name": "Dossier personnel", "path": home })];
    for base in ["/Volumes", "/media", "/mnt"] {
        if let Ok(rd) = std::fs::read_dir(base) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if !n.starts_with('.') && e.path().is_dir() {
                    roots.push(serde_json::json!({ "name": n, "path": e.path().to_string_lossy() }));
                }
            }
        }
    }
    Ok(serde_json::json!({
        "path": dir.to_string_lossy(),
        "parent": dir.parent().map(|p| p.to_string_lossy().to_string()),
        "dirs": dirs,
        "gguf": gguf,
        "roots": roots,
    }))
}

/// Ouvre (ou ramène au premier plan) l'outil Diagnostic dans sa propre fenêtre
/// (traces des modèles, réponses orchestrées, Profiler). Depuis les Réglages ou
/// l'app Agents ouverts HORS du bureau, l'ouverture passait par un évènement
/// que seul le bureau écoute : sans bureau, le clic ne faisait rien.
#[tauri::command]
fn open_diagnostic(app: tauri::AppHandle, view: Option<String>) -> Result<(), String> {
    let view = view.filter(|v| ["traces", "orchestration", "profiler"].contains(&v.as_str())).unwrap_or_else(|| "traces".into());
    if let Some(win) = app.get_webview_window("diagnostic") {
        let _ = win.eval(&format!("location.hash = '{view}'"));
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let url = match view.as_str() {
        "orchestration" => "diagnostic/diagnostic.html#orchestration",
        "profiler" => "diagnostic/diagnostic.html#profiler",
        _ => "diagnostic/diagnostic.html#traces",
    };
    open_app_window_after_ipc(
        app,
        AppWindowSpec {
            label: "diagnostic",
            url,
            title: "Lumen — Diagnostic",
            width: 1240.0,
            height: 800.0,
            min_width: 900.0,
            min_height: 560.0,
            maximized: false,
        },
    )
}





/// Ouvre (ou ramène au premier plan) l'Atelier des agents dans une fenêtre dédiée
/// (maximisée), pensée pour être affichée en permanence sur un écran dédié. Gardé
/// par la feature `atelier` : sans elle, la commande ne fait rien (et la carte est
/// masquée côté front).
#[tauri::command]
fn open_atelier(app: tauri::AppHandle) -> Result<(), String> {
    if !cfg!(feature = "atelier") {
        return Ok(());
    }
    open_app_window_after_ipc(
        app,
        AppWindowSpec {
            label: "atelier",
            url: "village/village.html",
            title: "Lumen — Atelier des agents",
            width: 1100.0,
            height: 740.0,
            min_width: 820.0,
            min_height: 520.0,
            maximized: true,
        },
    )
}

/// Ouvre (ou ramene au premier plan) la fenetre de parametres dediee.
#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    diag_file_log(&app, "settings", "open_settings called");
    run_window_task_after_ipc(&app, "settings", |app| {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        diag_file_log(&app, "settings", "window task started");
        if let Some(win) = app.get_webview_window("settings") {
            diag_file_log(&app, "settings", "existing window found");
            let _ = win.show();
            let _ = win.set_focus();
            normalize_child_window(&win);
            return Ok(());
        }
        diag_file_log(&app, "settings", "before window build");
        let win = WebviewWindowBuilder::new(
            &app,
            "settings",
            WebviewUrl::App("settings/settings.html".into()),
        )
        .title("Lumen — Paramètres")
        .inner_size(1040.0, 760.0)
        .min_inner_size(820.0, 540.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
        diag_file_log(&app, "settings", "window built");
        normalize_child_window(&win);
        attach_webview_diagnostics(&win, "settings");
        Ok(())
    })
}

/// Ouvre (ou ramene au premier plan) l'assistant de configuration dedie.
#[tauri::command]
fn open_onboarding(app: tauri::AppHandle) -> Result<(), String> {
    diag_file_log(&app, "onboarding", "open_onboarding called");
    run_window_task_after_ipc(&app, "onboarding", |app| {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        diag_file_log(&app, "onboarding", "window task started");
        if let Some(win) = app.get_webview_window("onboarding") {
            diag_file_log(&app, "onboarding", "existing window found");
            let _ = win.show();
            let _ = win.set_focus();
            normalize_child_window(&win);
            return Ok(());
        }
        diag_file_log(&app, "onboarding", "before window build");
        let win = WebviewWindowBuilder::new(
            &app,
            "onboarding",
            WebviewUrl::App("onboarding/setup.html".into()),
        )
        .title("Lumen — Assistant de configuration")
        .inner_size(980.0, 720.0)
        .min_inner_size(760.0, 520.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
        diag_file_log(&app, "onboarding", "window built");
        normalize_child_window(&win);
        attach_webview_diagnostics(&win, "onboarding");
        Ok(())
    })
}

/// Ouvre (ou ramène au premier plan) la boîte à outils (launcher des modules).
#[tauri::command]
fn open_toolbox(app: tauri::AppHandle) -> Result<(), String> {
    diag_file_log(&app, "toolbox", "open_toolbox called");
    run_window_task_after_ipc(&app, "toolbox", |app| {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        diag_file_log(&app, "toolbox", "window task started");
        if let Some(win) = app.get_webview_window("toolbox") {
            diag_file_log(&app, "toolbox", "existing window found");
            let _ = win.show();
            let _ = win.set_focus();
            normalize_child_window(&win);
            return Ok(());
        }
        diag_file_log(&app, "toolbox", "before window build");
        let win = WebviewWindowBuilder::new(
            &app,
            "toolbox",
            WebviewUrl::App("toolbox/toolbox.html".into()),
        )
        .title("Lumen — Boîte à outils")
        .inner_size(1120.0, 760.0)
        .min_inner_size(920.0, 640.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
        diag_file_log(&app, "toolbox", "window built");
        normalize_child_window(&win);
        attach_webview_diagnostics(&win, "toolbox");
        Ok(())
    })
}

























/// Alias historique de `open_budget` (l'app s'appelait « Finance »). Conservé
/// pour les workflows Fluxo et les boîtes à outils déjà enregistrés.
#[tauri::command]
fn open_finance(app: tauri::AppHandle) -> Result<(), String> {
    open_budget(app)
}

/// Dictée vocale, indépendante du moteur d'actions choisi. Principe : utiliser
/// la dictée **native de l'OS** quand elle est disponible (légère, intégrée,
/// respecte les réglages système), et ne retomber sur le repli portable
/// (Fluxo + Whisper) que si aucune voie native n'aboutit.
///
/// - **macOS** : dictée système via le Raccourci « Dictate Text ». On ne bascule
///   sur le repli que si le raccourci échoue (ex. absent) — un résultat vide
///   (l'utilisateur n'a rien dit) reste un succès natif.
/// - **Windows / Linux** : pas d'API native renvoyant le texte de façon fiable
///   aujourd'hui → repli Fluxo/Whisper. Le jour où une voie native existe, elle
///   s'insère ici sans toucher au reste.
/// Saveur de build : « rpi » pour l'export Raspberry Pi, « linux-standard » pour
/// le build desktop Linux natif, « windows » pour Windows, sinon « default ». Le
/// frontend adapte l'UI en conséquence au démarrage.
#[tauri::command]
fn platform_flavor() -> String {
    if cfg!(feature = "rpi") {
        "rpi".into()
    } else if cfg!(feature = "linux-standard") || cfg!(target_os = "linux") {
        // Tout Linux utilise WebKitGTK (même en `dev`, sans la feature) → il a
        // besoin du correctif verre dépoli (backdrop-filter non peint).
        "linux-standard".into()
    } else if cfg!(target_os = "windows") {
        "windows".into()
    } else {
        "default".into()
    }
}

/// Vrai si ce Linux tourne sur le pilote NVIDIA propriétaire.
///
/// Le module noyau publie `/proc/driver/nvidia/version` (et `/sys/module/nvidia`)
/// dès qu'il est chargé ; `nouveau` ne crée ni l'un ni l'autre. On ne lance
/// aucun binaire (`glxinfo`, `nvidia-smi`) : la détection sert au tout début du
/// démarrage, avant même la fenêtre, et doit coûter deux `stat`.
pub fn linux_proprietary_nvidia() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/proc/driver/nvidia/version").exists()
            || std::path::Path::new("/sys/module/nvidia/version").exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Saveur GPU : « nvidia » quand le pilote propriétaire est en place (rendu
/// WebKitGTK dégradé : rémanence, ombres noires, lag), sinon "". Le frontend
/// pose une classe sur `<body>` pour retirer les effets décoratifs coûteux.
#[tauri::command]
fn gpu_flavor() -> String {
    if linux_proprietary_nvidia() { "nvidia".into() } else { String::new() }
}

/// Nom du produit tel que le bundle le porte : « Lumen » ou « Lumen Pro ».
///
/// L'interface s'en sert plutôt que d'écrire le nom en dur : une seule source
/// de vérité, celle qui figure aussi sur l'icône, dans le Dock et dans le menu.
#[tauri::command]
fn product_name(app: tauri::AppHandle) -> String {
    app.package_info().name.clone()
}

/// Indique si ce binaire est une **édition Pro** (feature de compilation `pro`).
///
/// L'édition Pro ajoute cinq applications destinées aux usages professionnels :
/// Relia (CRM & facturation), Réunion (visio sur réseau local), DB Studio
/// (modélisation de base de données) et Reporting. Sans le flag, le frontend ne
/// les affiche NULLE PART — ni launcher, ni dock, ni la recherche globale, ni documentation
/// — et les commandes qui leur sont propres ne sont pas enregistrées.
/// Démarre le serveur loopback en signalant clairement un échec.
///
/// Cet appel était fait en `let _ = …` à trois endroits : quand le port 8765
/// était déjà pris par un autre programme, Lumen continuait sans serveur local,
/// et les blocs de retour de Fluxo POSTaient droit sur l'intrus. Le message qui
/// remontait alors était celui de l'intrus — « Lumen a refusé la requête :
/// 401 » — c'est-à-dire un reproche adressé à Lumen pour une réponse écrite par
/// quelqu'un d'autre, sans aucune piste vers la vraie cause.
///
/// On ne fait pas ÉCHOUER le run pour autant : la plupart des workflows
/// n'utilisent aucun bloc de retour et tournent très bien sans. On journalise,
/// et on le dit dans le centre de notifications — une fois, pas à chaque run.
async fn ensure_loopback_server(app: &tauri::AppHandle) {
    let rt = app.state::<companion::CompanionRuntime>();
    let Err(err) = companion::ensure_server(app, rt.inner()).await else {
        return;
    };
    eprintln!("Serveur loopback indisponible : {err}");
    // `swap` : le premier échec parle, les suivants se taisent. Répéter le même
    // avertissement à chaque exécution d'un workflow programmé noierait le
    // centre de notifications.
    static WARNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if WARNED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    emit_center(
        app,
        serde_json::json!({
            "shortcut": "Serveur local de Lumen",
            "output": err,
            "success": false,
            "source": "lumen",
        }),
    );
}

#[tauri::command]
fn pro_enabled(_app: tauri::AppHandle) -> bool {
    // Plus de licence pour les APPLICATIONS (Relia, DB Studio, Reporting,
    // Réunion…) : elles sont ouvertes à tous. Seul le flag de compilation
    // compte encore — sans lui leurs commandes Rust n'existent pas (c'est le
    // défaut). La licence ne concerne plus que Lumen Server (cf. agents.rs et
    // `start_server_agent_worker`, qui appellent `license::is_pro`).
    cfg!(feature = "pro")
}

/// Indique si l'app « Atelier des agents » (WIP) est incluse dans ce build.
/// Activée par la feature de compilation `atelier`. Le frontend masque l'app
/// (menu start + bouton dans Agents) quand c'est `false`.
#[tauri::command]
fn atelier_enabled() -> bool {
    cfg!(feature = "atelier")
}

#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
async fn dictate(app: tauri::AppHandle, shortcut_name: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(text) = call_macos_shortcut(shortcut_name.clone(), String::new()).await {
            return Ok(text);
        }
    }
    // Linux/Raspberry Pi : dictée locale via whisper.cpp (STT offline), si installé.
    #[cfg(target_os = "linux")]
    {
        if let Ok(Ok(text)) = tauri::async_runtime::spawn_blocking(whisper_dictate_local).await {
            if !text.is_empty() {
                return Ok(text);
            }
        }
    }
    // Repli portable : workflow Fluxo verrouillé « Dicter le texte ».
    run_fluxo_workflow(app, "Dicter le texte".into(), String::new(), None, None).await
}

/// Dictée locale (Raspberry Pi / Linux) : enregistre un court clip audio puis le
/// transcrit avec whisper.cpp. Binaire + modèle posés par scripts/whisper/install.sh
/// dans /opt/whisper. Bloquant → appelé via spawn_blocking.
#[cfg(target_os = "linux")]
fn whisper_dictate_local() -> Result<String, String> {
    use std::path::Path;
    let bin = ["/opt/whisper/whisper-cli", "/opt/whisper/main"]
        .iter()
        .copied()
        .find(|p| Path::new(p).exists())
        .ok_or("Dictée indisponible : whisper.cpp non installé (scripts/whisper/install.sh).")?;
    let model = Path::new("/opt/whisper/models/ggml-base.bin");
    if !model.exists() {
        return Err("Modèle whisper absent (/opt/whisper/models/ggml-base.bin).".into());
    }
    let wav = std::env::temp_dir().join("lumen_dictate.wav");
    whisper_record_clip(&wav, 6)?;

    let mut cmd = std::process::Command::new(bin);
    cmd.args([
        "-m",
        &model.to_string_lossy(),
        "-f",
        &wav.to_string_lossy(),
        "-l",
        "auto", // détection FR/EN automatique
        "-nt",  // sans horodatage
        "-np",  // sans logs de progression
    ]);
    crate::tts::scrub_appimage_env(&mut cmd);
    let out = cmd.output().map_err(|e| {
        format!("whisper-cli introuvable ({e}). Réinstalle : scripts/whisper/install.sh")
    })?;
    if !out.status.success() {
        return Err(format!(
            "whisper a échoué : {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Enregistre `secs` secondes en 16 kHz mono (format attendu par whisper).
/// PipeWire/Pulse d'abord (même périphérique que le navigateur), sinon ALSA.
#[cfg(target_os = "linux")]
fn whisper_record_clip(wav: &std::path::Path, secs: u32) -> Result<(), String> {
    let _ = if crate::tts::bin_in_path("parecord") {
        // `timeout` arrête l'enregistrement (code 124 = normal, ignoré).
        std::process::Command::new("timeout")
            .arg(secs.to_string())
            .arg("parecord")
            .args([
                "--rate=16000",
                "--channels=1",
                "--format=s16le",
                "--file-format=wav",
            ])
            .arg(wav)
            .status()
    } else {
        std::process::Command::new("arecord")
            .args([
                "-q",
                "-d",
                &secs.to_string(),
                "-f",
                "S16_LE",
                "-r",
                "16000",
                "-c",
                "1",
            ])
            .arg(wav)
            .status()
    };
    // On valide via la taille du fichier (le statut de `timeout` n'est pas fiable).
    if std::fs::metadata(wav).map(|m| m.len()).unwrap_or(0) < 1000 {
        return Err(
            "Enregistrement vide : micro indisponible ? (installe pulseaudio-utils ou alsa-utils)"
                .into(),
        );
    }
    Ok(())
}

// ===== Dispatch vers le Action Router =====
//
// Lumen n'exécute pas l'action lui-même : il envoie au Action Router (un
// raccourci macOS « adapté ») une enveloppe JSON contenant le `run_id`, le
// prompt et l'URL de callback. Le routeur fait le travail et POSTe sa
// progression sur `http://127.0.0.1:8765/run/progress` (relayée à l'UI en
// temps réel → effet réactif). Le **résultat final** reste le `stdout` du
// raccourci, renvoyé ici à la fin.
//
// Le `run_id` est généré par le frontend et passé ici, pour qu'il puisse créer
// le message « tâche » et s'abonner aux évènements *avant* tout retour.
const RUN_CALLBACK_URL: &str = "http://127.0.0.1:8765/run/progress";

#[derive(Serialize)]
struct ActionResult {
    run_id: String,
    output: String,
    success: bool,
}

#[tauri::command]
async fn dispatch_action(
    app: tauri::AppHandle,
    rt: tauri::State<'_, companion::CompanionRuntime>,
    run_id: String,
    router_shortcut: String,
    prompt: String,
    conversation_id: Option<String>,
    lang: Option<String>,
) -> Result<ActionResult, String> {
    // S'assurer que le serveur 8765 écoute pour recevoir les callbacks.
    companion::ensure_server(&app, rt.inner()).await?;

    let envelope = serde_json::json!({
        "v": 1,
        "run_id": run_id,
        "input": prompt,
        "callback": RUN_CALLBACK_URL,
        "conversation_id": conversation_id,
        "lang": lang,
    })
    .to_string();

    let shortcut = router_shortcut.clone();
    let res =
        tauri::async_runtime::spawn_blocking(move || run_shortcut_capture(&shortcut, &envelope))
            .await
            .map_err(|e| format!("Tâche interrompue : {e}"))?;

    Ok(ActionResult {
        run_id,
        output: res.output,
        success: res.success,
    })
}

/// Affiche/masque la fenêtre principale (orbe + barre). Utilisé par le hotkey
/// global, le clic sur l'icône menu-bar et son menu, et la relance d'instance.
fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
            // Place le curseur directement dans la barre de saisie pour pouvoir
            // taper dans la foulée (le front écoute « focus-input »).
            let _ = win.emit("focus-input", ());
        }
    }
}

/// Ramène la fenêtre principale au premier plan (sans la masquer).
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("focus-input", ());
    }
}

/// Déclenche « Comprendre cet écran » depuis un point d'entrée système (menu de
/// la barre d'état, raccourci global). La capture elle-même est faite par la
/// WebView, qui sait quel moteur est actif et où afficher la réponse : on se
/// contente de montrer la fenêtre principale et de lui passer la demande.
///
/// L'événement part sur la SEULE fenêtre principale (et non en diffusion) : le
/// bureau Lumen OS a sa propre entrée dans son menu contextuel, et deux surfaces
/// qui répondent au même raccourci enverraient deux captures au modèle.
fn request_understand_screen(app: &tauri::AppHandle) {
    emit_to_main(app, "understand-screen");
}

/// Même chose, mais l'utilisateur tracera d'abord la zone à faire lire.
fn request_understand_region(app: &tauri::AppHandle) {
    emit_to_main(app, "understand-screen-region");
}

fn emit_to_main(app: &tauri::AppHandle, event: &str) {
    // Bureau (Lumen Desktop) visible : c'est LUI qui doit lire l'écran et
    // répondre, pas la barre flottante — sinon la réponse surgissait dans la
    // petite fenêtre de chat alors que l'utilisateur travaillait sur le bureau.
    // Nom d'événement distinct : `listen()` côté web reçoit aussi les
    // événements adressés à une autre fenêtre, et la barre répondrait en double.
    if let Some(desktop) = app.get_webview_window("sandbox-explorer") {
        let visible = desktop.is_visible().unwrap_or(false) && !desktop.is_minimized().unwrap_or(false);
        if visible {
            let _ = desktop.emit(&format!("{event}-desktop"), ());
            return;
        }
    }
    if let Some(win) = app.get_webview_window("main") {
        // On n'affiche PAS la fenêtre ici : elle se retrouverait sur la capture,
        // par-dessus l'app que l'utilisateur voulait justement faire lire. Le
        // front capture d'abord, puis se montre pour afficher la réponse.
        let _ = win.emit(event, ());
    }
}

/// Construit l'icône menu-bar (NSStatusItem) et son menu.
#[cfg(desktop)]
/// Glyphe monochrome de la barre des menus, décodé depuis les PNG embarqués
/// (`icons/tray@2x.png` : 44 px, net sur Retina et réduit proprement ailleurs).
fn tray_glyph() -> Option<tauri::image::Image<'static>> {
    let decoded = image::load_from_memory(include_bytes!("../icons/tray@2x.png")).ok()?.to_rgba8();
    let (w, h) = decoded.dimensions();
    Some(tauri::image::Image::new_owned(decoded.into_raw(), w, h))
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let toggle_item = MenuItem::with_id(
        app,
        "toggle",
        "Afficher / Masquer Lumen",
        true,
        None::<&str>,
    )?;
    // « Comprendre cet écran » depuis n'importe quelle app : c'est justement
    // quand Lumen n'est PAS au premier plan qu'on en a besoin. Les « … » sont
    // tenus : la fenêtre montre d'abord la question, pré-remplie et modifiable,
    // et n'envoie qu'après validation.
    let understand_item = MenuItem::with_id(
        app,
        "understand-screen",
        "Comprendre cet écran…",
        true,
        None::<&str>,
    )?;
    // Variante ciblée : c'est le cas le plus courant en pratique (un message
    // d'erreur, un tableau, un paragraphe), et l'écran entier noie la question.
    let region_item = MenuItem::with_id(
        app,
        "understand-region",
        "Comprendre une zone…",
        true,
        None::<&str>,
    )?;
    // Le nom du produit vient du bundle (« Lumen » ou « Lumen Pro » selon la
    // configuration de build) : le menu et l'infobulle le suivent, plutôt que
    // d'afficher un nom en dur qui mentirait dans l'édition Pro.
    let product = app.package_info().name.clone();
    let quit_item = MenuItem::with_id(app, "quit", format!("Quitter {product}"), true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quick_item = MenuItem::with_id(app, "quick-prompt", "Question rapide…", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quick_item, &toggle_item, &understand_item, &region_item, &sep, &quit_item])?;

    // Icône de barre des menus : le GLYPHE Lumen (anneau + deux barres) et non
    // l'icône de l'app. Une image « template » ne garde que l'alpha : avec
    // l'icône complète — un carré arrondi plein — macOS ne montrait qu'un
    // carré blanc. Le PNG @2x sert aux écrans Retina.
    let tray_icon = tray_glyph().unwrap_or_else(|| app.default_window_icon().unwrap().clone());
    TrayIconBuilder::with_id("lumen-tray")
        .icon(tray_icon)
        .icon_as_template(true)
        .tooltip(&product)
        .menu(&menu)
        // Le menu ne s'ouvre que sur clic droit ; le clic gauche bascule la fenêtre.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quick-prompt" => { let _ = quick_prompt::toggle(app); },
            "toggle" => toggle_main_window(app),
            "understand-screen" => request_understand_screen(app),
            "understand-region" => request_understand_region(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Combinaison retenue pour « Comprendre cet écran ». Renseignée une fois au
/// démarrage (la première libre de la liste de repli) et relue par le handler
/// global, qui reçoit toutes les pressions sans distinction.
#[cfg(desktop)]
static UNDERSTAND_SHORTCUT: std::sync::OnceLock<tauri_plugin_global_shortcut::Shortcut> =
    std::sync::OnceLock::new();
#[cfg(desktop)]
static QUICK_PROMPT_SHORTCUT: std::sync::OnceLock<tauri_plugin_global_shortcut::Shortcut> =
    std::sync::OnceLock::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// `Lumen --mcp-stdio` : pont stdio → serveur MCP local (clients qui ne
/// parlent que stdio, comme Claude Desktop). Lumen doit être lancé.
pub fn mcp_stdio_bridge() -> i32 {
    let _ = rustls::crypto::ring::default_provider().install_default();
    mcp_server::run_stdio_bridge()
}

pub fn run() {
    // Tiberius enables aws-lc-rs alongside ring. Set an explicit process default
    // before dependencies (mail/HTTP clients) construct their TLS configuration.
    let _ = rustls::crypto::ring::default_provider().install_default();
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    let mut builder = tauri::Builder::default();

    // Schéma des applications installées. Chaque app y reçoit sa propre origine
    // (`lumenapp://<id>/`), ce qui la coupe du bureau et des autres apps aussi
    // sûrement que deux sites web le sont entre eux. Cf. src/appserve.rs.
    builder = builder.register_uri_scheme_protocol("lumenapp", |ctx, request| {
        appserve::handle(ctx.app_handle(), request.map(|b| b.to_vec()))
    });
    // Fichiers audio/vidéo des sandboxes, servis avec les requêtes partielles
    // (lecture et avance rapide sans tout charger en mémoire) — cf. media.rs.
    builder = builder.register_uri_scheme_protocol("lumenmedia", |ctx, request| {
        media::handle(ctx.app_handle(), request.map(|b| b.to_vec()))
    });

    // Instance unique : une 2ᵉ tentative de lancement ramène la fenêtre au lieu
    // d'ouvrir un doublon. Doit être enregistré en premier.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }));
        // Mise à jour automatique. L'updater ne fait rien tant que `pubkey` est
        // vide dans tauri.conf.json (cf. scripts/setup-updater.mjs) : la
        // vérification renvoie alors une erreur explicite que l'interface
        // affiche, plutôt que d'échouer au démarrage.
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                // On n'enregistre qu'un seul raccourci d'invocation ; toute pression
                // déclenche donc la bascule (pas besoin de comparer le Shortcut, ce
                // qui permet de choisir dynamiquement une combinaison libre).
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // Deux raccourcis seulement : celui de « Comprendre cet
                    // écran » (mémorisé au démarrage, la combinaison retenue
                    // dépendant de ce qui était libre) et, par défaut, celui
                    // d'invocation de la fenêtre.
                    if UNDERSTAND_SHORTCUT.get() == Some(shortcut) {
                        request_understand_screen(app);
                    } else if QUICK_PROMPT_SHORTCUT.get() == Some(shortcut) {
                        if let Err(error) = quick_prompt::toggle(app) { eprintln!("Accès rapide : {error}"); }
                    } else {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        // Linux : micro/caméra refusés par WebKitGTK tant qu'on ne les accorde
        // pas nous-mêmes (cf. webview_media.rs). Sans effet ailleurs.
        .on_page_load(|webview, _payload| webview_media::configure(webview))
        .setup(move |app| {
            // Localise le moteur vocal livré dans le bundle (Linux/Windows) une
            // fois pour toutes : la synthèse est appelée depuis des contextes
            // sans AppHandle.
            // Clés API : scellées, hors de l'environnement, dossier protégé.
            agents::install_secret_guards(app.handle());
            tts::init_bundled_piper(app.handle());
            llmlog::init(app.handle());
            devices::init(app.handle());
            autobackup::start(app.handle());
            report_subs::start(app.handle());
            datahub::start(app.handle());

            // ---- Mode borne (kiosque) ----
            //
            // `LUMEN_KIOSK=1` fait ouvrir le BUREAU directement, en plein écran,
            // au lieu de la barre de recherche. C'est ce que pose
            // `scripts/kiosk/install-kiosk.sh` sur un poste dédié : la borne
            // démarre sur l'écran de travail, sans qu'un humain ait à cliquer.
            //
            // Une variable d'environnement plutôt qu'un réglage : le réglage
            // vit dans le stockage de la webview, qu'un script d'installation
            // ne peut pas préparer. L'environnement, lui, se pose dans l'unité
            // systemd — là où l'administrateur décide justement de ce genre de
            // chose.
            // ---- Filet de sécurité du choix de mode ----
            // La fenêtre principale démarre CACHÉE (tauri.conf.json) : main.js
            // décide ensuite (écran de choix, mode mémorisé, assistant). Si rien
            // n'est visible au bout de 12 s (JS planté…), on montre la barre :
            // l'application ne doit jamais rester invisible.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(12)).await;
                    let any = ["main", "launcher", "onboarding", "sandbox-explorer"].iter().any(|l| {
                        handle.get_webview_window(l).map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false)
                    });
                    if !any {
                        if let Some(main) = handle.get_webview_window("main") {
                            let _ = main.show();
                        }
                    }
                });
            }
            if std::env::var("LUMEN_KIOSK").ok().as_deref() == Some("1") {
                let handle = app.handle().clone();
                // Après le démarrage : la fenêtre principale doit exister avant
                // qu'on en ouvre une seconde.
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                    if let Err(e) = open_sandbox_explorer(handle.clone(), None, Some(true)) {
                        eprintln!("Mode borne : ouverture du bureau impossible — {e}");
                    }
                    // La barre de recherche n'a pas sa place sur une borne : le
                    // bureau porte déjà la sienne.
                    if let Some(main) = handle.get_webview_window("main") {
                        let _ = main.hide();
                    }
                });
            }
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                // Hotkey global d'invocation : ⌥ Espace par défaut (macOS). Sous
                // Linux/Pi, Alt+Espace est souvent déjà pris par le bureau (menu
                // fenêtre) → on se rabat sur Super/Méta+Espace puis Ctrl+Alt+Espace.
                let candidates = [
                    Shortcut::new(Some(Modifiers::ALT), Code::Space),
                    Shortcut::new(Some(Modifiers::SUPER), Code::Space),
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space),
                ];
                let mut registered = None;
                for sc in candidates {
                    if app.global_shortcut().register(sc).is_ok() {
                        registered = Some(sc);
                        break;
                    }
                }
                if let Some(sc) = registered {
                    eprintln!("Hotkey global d'invocation : {sc:?}");
                } else {
                    eprintln!("Aucun raccourci d'invocation libre (Alt/Super/Ctrl+Alt + Espace tous pris).");
                }
                // Hotkey de « Comprendre cet écran » : ⌘⌥E sur macOS, sinon
                // Ctrl+Alt+E puis Super+Maj+E. Même logique de repli que
                // ci-dessus — une combinaison déjà prise par le système ne doit
                // pas empêcher l'enregistrement des autres.
                let understand_candidates = [
                    Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyE),
                    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyE),
                    Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyE),
                ];
                let mut understand = None;
                for sc in understand_candidates {
                    if app.global_shortcut().register(sc).is_ok() {
                        understand = Some(sc);
                        break;
                    }
                }
                if let Some(sc) = understand {
                    let _ = UNDERSTAND_SHORTCUT.set(sc);
                    eprintln!("Hotkey global « Comprendre cet écran » : {sc:?}");
                } else {
                    eprintln!("Aucun raccourci libre pour « Comprendre cet écran » (⌘⌥E / Ctrl+Alt+E / Super+Maj+E tous pris).");
                }
                let quick_modifiers = if cfg!(target_os = "macos") { Modifiers::SUPER | Modifiers::ALT } else { Modifiers::CONTROL | Modifiers::ALT };
                for sc in [Shortcut::new(Some(quick_modifiers), Code::KeyP), Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyP)] {
                    if app.global_shortcut().register(sc).is_ok() {
                        let _ = QUICK_PROMPT_SHORTCUT.set(sc);
                        eprintln!("Hotkey accès rapide : {sc:?}");
                        break;
                    }
                }
                // Icône dans la barre de menus.
                if let Err(e) = build_tray(app.handle()) {
                    eprintln!("Impossible de créer l'icône menu-bar : {e}");
                }
            }
            // Charge la mémoire persistante (optionnelle : n'échoue jamais le
            // démarrage). Le store est déjà `manage`d ci-dessous.
            let mem = app.state::<memory::MemoryStore>().inner().clone();
            let recall = app.state::<recall::RecallStore>().inner().clone();
            let auth = app.state::<auth::AuthState>().inner().clone();
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                mem.init(&handle).await;
                recall.init(&handle).await;
                auth.init(&handle).await;
            });
            // Sème le workflow routeur par défaut (équivalent du Action Router
            // Apple) s'il manque. Best-effort.
            ensure_default_router(app.handle());
            // Initialise le control plane transactionnel des agents. Best-effort :
            // une base absente/corrompue ne doit pas empêcher l'UI de démarrer.
            if let Err(e) = agent_runtime::recover_after_restart(app.handle()) {
                eprintln!("Runtime agentique indisponible : {e}");
            }
            // Passerelle Telegram : reprend le polling si elle était activée.
            telegram::autostart(app.handle());
            slack::autostart(app.handle());
            // Documents vivants : replanifie les blocs tenus à jour par un agent.
            living::autostart(app.handle());
            // Planifie les agents activés (un job CRON par agent) au démarrage.
            let app_agents = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app_agents.state::<agents::AgentRuntime>();
                let _ = agents::reschedule(app_agents.clone(), &state).await;
            });
            // Worker d'exécution Lumen Server : les demandes restent dans la
            // file durable du serveur, puis un poste Pro connecté les exécute
            // dans le contexte local du propriétaire (connecteurs, sandbox,
            // approbations et secrets ne quittent jamais ce poste).
            start_server_agent_worker(app.handle().clone());
            let app_workflows = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app_workflows.state::<WorkflowSchedulerState>();
                let _ = reschedule_workflows(app_workflows.clone(), state.inner()).await;
            });
            // Ticker des rappels : balaie les échéances toutes les 30 s et
            // déclenche les rappels arrivés à terme (notification + orbe). Léger
            // (lecture d'un petit JSON), rattrape les échéances manquées hors-ligne.
            let app_rem = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
                loop {
                    tick.tick().await;
                    let app2 = app_rem.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || reminders::check_due(&app2)).await;
                }
            });
            Ok(())
        })
        .manage(HeartbeatState::default())
        .manage(WorkflowSchedulerState::default())
        .manage(agents::AgentRuntime::default())
        .manage(browser::BrowserState::default())
        .manage(tts::TtsState::default())
        .manage(memory::MemoryStore::default())
        .manage(recall::RecallStore::default())
        .manage(auth::AuthState::default())
        .manage(session::SessionState::default())
        .manage(bonsai::BonsaiState::default())
        .manage(imageplayground::ImagePlaygroundState::default())
        .manage(companion::CompanionRuntime::default())
        .manage(llama::LlamaState::default())
        .manage(litert::LitertState::default())
        .manage(applefm::AppleFmState::default())
        .manage(mcp::McpState::default())
        .manage(telegram::TelegramState::default())
        .manage(slack::SlackState::default())
        .manage(living::LivingState::default())
        .manage(IslandQueue::default())
        .manage(screen::PendingSelection::default())
        .invoke_handler(tauri::generate_handler![
            close_window,
            close_current_window,
            minimize_window,
            set_always_on_top,
            start_drag,
            set_ignore_cursor_events,
            cursor_pos_in_window,
            cursor_pos_global,
            set_window_position,
            resize_window,
            frontend_log,
            ollama_list_models,
            ollama_get_json,
            ollama_post_json,
            ollama_pull,
            llama::llama_list_models,
            llama::llama_catalog_models,
            llama::llama_model_dirs,
            llama::llama_model_dirs_set,
            llama::llama_download_model,
            llama::llama_cancel_download,
            llama::llama_partial_downloads,
            hardware::system_resources,
            power::power_status,
            profiler::profiler_system_stats,
            prompts::prompt_overrides_get,
            prompts::prompt_defaults_get,
            prompts::prompt_overrides_set,
            mcp::mcp_servers,
            mcp::mcp_save_server,
            mcp::mcp_delete_server,
            mcp::mcp_set_enabled,
            mcp::mcp_set_tool_enabled,
            mcp::mcp_tools,
            mcp::mcp_probe,
            mcp::mcp_call_tool,
            mcp::mcp_bar_tools,
            mcp::mcp_catalog,
            llama::llama_delete_model,
            llama::llama_start,
            llama::llama_embed_start,
            llama::llama_summary_status,
            llama::llama_summarize,
            llama::llama_perf_get,
            llama::llama_perf_set,
            llama::llama_dspark_info,
            llama::llama_dspark_catalog,
            mcp_server::mcp_server_get,
            mcp_server::mcp_server_set,
            rerank::rerank_status,
            rerank::rerank_config_set,
            rerank::rerank_download_model,
            rerank::rerank_delete_model,
            whisper::whisper_native_status,
            whisper::whisper_download_model,
            whisper::whisper_delete_model,
            whisper::whisper_warmup,
            whisper::whisper_transcribe,
            llama::decision_status,
            llama::decision_decide,
            llama::decision_stop,
            quick_prompt::quick_prompt_toggle,
            quick_prompt::quick_prompt_hide,
            quick_prompt::quick_prompt_resize,
            llama::ocr::ocr_models,
            llama::ocr::vision_ocr,
            llama::vision_look,
            llama::vision_stop,
            llama::decision_ollama_import,
            llama::decision_set_enabled,
            llama::decision_set_model,
            set_shell_mode,
            companion::companion_tls_fingerprint,
            toggle_maximize,
            shell_start_view,
            open_mode_picker,
            apply_shell_choice,
            llama::llama_embed_status,
            llama::llama_embed_stop,
            llama::llama_stop,
            llama::llama_status,
            llama::llama_backends,
            llama::llama_set_backend,
            llama::llama_get_json,
            llama::llama_post_json,
            litert::litert_runtime,
            litert::litert_list_models,
            litert::litert_download_model,
            litert::litert_cancel_download,
            litert::litert_delete_model,
            litert::litert_start,
            litert::litert_stop,
            litert::litert_status,
            litert::litert_get_json,
            litert::litert_post_json,
            applefm::applefm_status,
            applefm::applefm_start,
            applefm::applefm_stop,
            web_fetch,
            web_fetch_raw,
            web_fetch_rendered,
            live_data::live_weather,
            live_data::live_weather_data,
            live_data::live_sport_score,
            live_data::live_market_quote,
            live_data::live_exchange_rate,
            live_data::live_air_quality,
            live_data::live_news,
            native_tools::native_tool_catalog,
            native_tools::web_tools_config_get,
            native_tools::web_tools_config_set,
            island_drain,
            island_set_size,
            island_hide,
            island_show,
            halo_set_enabled,
            halo_is_enabled,
            halo_set_position,
            halo_set_style,
            halo_get_style,
            capsule_focus_main,
            hooks::agent_hook_install,
            notify_island,
            open_external,
            list_shortcuts,
            call_macos_shortcut,
            start_heartbeat,
            stop_heartbeat,
            list_fluxo_workflows,
            list_fluxo_tool_workflows,
            run_fluxo_workflow,
            system_speak,
            system_voice_list,
            stop_speaking,
            list_actions,
            list_workflows,
            load_workflow,
            save_workflow,
            delete_workflow,
            run_workflow,
            reload_triggers,
            list_workflow_schedules,
            list_workflow_runs,
            run_scheduled_workflow,
            app_windows::open_fluxo_designer,
            app_windows::open_automations,
            open_sandbox_explorer,
            ml_embed_result,
            reporting_export_result,
            app_windows::open_agents_manager,
            app_windows::open_docs,
            app_windows::open_profiler,
            open_diagnostic,
            fs_browse_dirs,
            open_atelier,
            open_settings,
            open_onboarding,
            app_windows::open_kanban_board,
            app_windows::open_inbox,
            app_windows::open_domotique,
            app_windows::open_data_analysis,
            app_windows::open_budget,
            open_finance,
            app_windows::open_image_studio,
            app_windows::open_moodboard,
            open_toolbox,
            orb_bridge::orb_connect,
            orb_bridge::orb_send,
            orb_bridge::orb_send_wav,
            orb_bridge::orb_send_sprite,
            orb_bridge::orb_disconnect,
            orb_bridge::orb_ota,
            kanban::kanban_load,
            morning::morning_config_get,
            morning::morning_config_set,
            morning::morning_brief,
            morning::morning_news,
            morning::morning_topics_set,
            kanban::kanban_save,
            domotique::domotique_discover,
            domotique::domotique_call,
            domotique::domotique_devices_summary,
            domotique::domotique_device_state,
            domotique::domotique_device_cmd,
            domotique::domotique_devices_load,
            domotique::domotique_devices_save,
            serialflash::domotique_serial_ports,
            serialflash::domotique_pico_upload,
            serialflash::domotique_pico_bootsel,
            serialflash::domotique_pico_flash_uf2,
            serialflash::domotique_esp_flash,
            telegram::telegram_status,
            telegram::telegram_set_token,
            telegram::telegram_clear_token,
            telegram::telegram_set_enabled,
            telegram::telegram_set_options,
            telegram::telegram_new_pair_code,
            telegram::telegram_revoke_chat,
            telegram::telegram_test,
            telegram::telegram_threads,
            telegram::telegram_thread,
            telegram::telegram_reply,
            telegram::telegram_thread_clear,
            slack::slack_status,
            session::session_authorize_config,
            sandbox::sandbox_list_names,
            living::living_list,
            living::living_save,
            living::living_delete,
            living::living_run,
            living::living_delegate,
            living::living_markdown_html,
            living::living_parse_table,
            living::living_office_files,
            living::living_file_preview,
            slack::slack_set_tokens,
            slack::slack_clear_tokens,
            slack::slack_set_enabled,
            slack::slack_set_options,
            slack::slack_new_pair_code,
            slack::slack_revoke_user,
            slack::slack_test,
            slack::slack_threads,
            slack::slack_thread,
            inbox::inbox_load,
            inbox::inbox_save,
            inbox::inbox_post,
            app_windows::open_calendar,
            app_windows::open_storage,
            app_windows::open_games,
            app_windows::open_knowledge,
            reminders::reminders_load,
            reminders::reminders_save,
            reminders::reminder_add,
            reminders::reminder_delete,
            reminders::reminder_set_done,
            reminders::reminders_check_now,
            rag::rag_add_text,
            rag::rag_add_file,
            rag::rag_add_file_bytes,
            rag::rag_search,
            rag::rag_status,
            rag::rag_list,
            rag::rag_doc_text,
            rag::rag_delete,
            rag::rag_clear,
            rag::rag_reindex,
            rag::rag_set_chunk_preset,
            rag::rag_set_embed_pref,
            rag::doc_extract_text,
            rag::rag_get_embed_pref,
            tables::table_base_list,
            storage::app_state_load,
            storage::app_state_save,
            storage::app_state_delete,
            storage::app_state_list,
            search::lumen_search,
            search::data_search,
            contacts::contacts_load,
            contacts::contacts_save,
            mail::mail_account_get,
            mail::mail_account_set,
            mail::mail_account_clear,
            mail::mail_load,
            mail::mail_drafts_load,
            mail::mail_drafts_save,
            mail::mail_save,
            mail::mail_chat_tool,
            mail::mail_sync,
            mail::mail_test,
            mail::mail_send,
            mail::mail_send_rich,
            report_subs::report_subs_list,
            report_subs::report_subs_save,
            report_subs::report_subs_mark,
            storage::storage_report,
            storage::storage_clear,
            storage::diagnostic_logs_clear,
            storage::diagnostic_logs_size,
            backup::backup_estimate,
            backup::backup_export,
            backup::backup_export_selection,
            backup::backup_estimate_selection,
            backup::backup_inspect,
            backup::backup_import,
            backup::backup_reveal,
            tables::table_base_create,
            tables::table_base_rename,
            tables::table_base_delete,
            tables::table_list,
            tables::table_create,
            tables::table_rename,
            tables::table_delete,
            tables::table_schema,
            tables::table_base_schema,
            tables::table_column_add,
            tables::table_column_rename,
            tables::table_column_retype,
            tables::table_column_delete,
            tables::table_column_meta,
            tables::table_column_reorder,
            tables::table_meta_set,
            tables::table_meta_get,
            tables::table_rows,
            tables::table_row_insert,
            tables::table_row_update,
            tables::table_row_delete,
            tables::table_query,
            tables::table_export_csv,
            tables::table_import_csv,
            sandbox::sandbox_list,
            pi_deploy::pi_ssh_exec,
            pi_deploy::pi_scp_push,
            pi_deploy::pi_http_json,
            sandbox::sandbox_create,
            sandbox::sandbox_delete,
            sandbox::sandbox_set_size,
            sandbox::sandbox_import_file,
            sandbox::sandbox_export_file,
            sandbox::sandbox_usage,
            sandbox::sandbox_read_dir,
            native_tools::sandbox_find_files,
            sandbox::sandbox_read_file,
            sandbox::sandbox_read_document,
            sandbox::sandbox_file_candidates,
            sandbox::sandbox_read_b64,
            sandbox::sandbox_read_image_b64,
            sandbox::sandbox_list_images,
            sandbox::sandbox_image_thumb,
            sandbox::sandbox_write_file,
            sandbox::sandbox_pdf_formats,
            sandbox::sandbox_export_pdf,
            sandbox::sandbox_write_pdf,
            sandbox::sandbox_export_creative_pdf,
            sandbox::sandbox_snapshot_list,
            sandbox::sandbox_snapshot_get,
            sandbox::sandbox_create_dir,
            sandbox::sandbox_create_file,
            sandbox::sandbox_rename,
            sandbox::sandbox_move_path,
            sandbox::sandbox_copy_path,
            sandbox::sandbox_transfer_path,
            sandbox::sandbox_move_all,
            sandbox::sandbox_delete_path,
            bonsai::bonsai_status,
            bonsai::bonsai_set_url,
            bonsai::bonsai_get_url,
            bonsai::bonsai_models,
            bonsai::bonsai_download_model,
            bonsai::bonsai_cancel_download,
            bonsai::bonsai_delete_model,
            bonsai::bonsai_engine_remote,
            bonsai::bonsai_download_engine,
            bonsai::bonsai_delete_engine,
            bonsai::bonsai_start,
            bonsai::bonsai_stop,
            bonsai::bonsai_generate_to_sandbox,
            bonsai::bonsai_backends,
            bonsai::bonsai_generate_to_sandbox_url,
            bonsai::bonsai_generate_data_url,
            bonsai::bonsai_save_png,
            bonsai::image_set_config,
            bonsai::image_get_config,
            bonsai::live_generate_image,
            imageplayground::imageplayground_status,
            agents::agent_list,
            agents::agent_save,
            agents::agent_delete,
            chat_runtime::chat_runtime_run,
            chat_runtime::chat_runtime_reply,
            chat_runtime::chat_runtime_cancel,
            agents::agent_set_fallback_model,
            agents::agent_run_now,
            agents::agent_publish_server,
            agents::agent_queue_server,
            agents::agent_delegate,
            doc_context::doc_gather_context,
            calendar_sync::ical_fetch,
            calendar_sync::gcal_status,
            calendar_sync::gcal_configure,
            calendar_sync::gcal_connect,
            calendar_sync::gcal_disconnect,
            calendar_sync::gcal_calendars,
            calendar_sync::gcal_events,
            calendar_sync::gcal_upsert,
            calendar_sync::gcal_delete,
            media::media_append_b64,
            media::media_ffmpeg_status,
            media::media_convert,
            browser::browser_open,
            browser::browser_new_tab,
            browser::browser_close_tab,
            browser::browser_activate,
            browser::browser_tabs,
            browser::browser_navigate,
            browser::browser_action,
            browser::browser_find,
            browser::browser_page_text,
            browser::browser_agent_snapshot,
            browser::browser_agent_act,
            browser::browser_set_side,
            browser::browser_extensions,
            browser::browser_set_lang,
            browser::browser_extensions_save,
            agents::agent_eval_suite,
            agents::agents_running,
            agents::agent_add_task,
            agents::agent_remove_task,
            agents::agent_set_tasks,
            pdf::chat_export_pdf,
            facturx::facturx_pdf,
            pdf::open_exported_file,
            agents::agent_activity,
            agents::agent_activity_clear,
            agents::agent_distill_memory,
            agents::agent_run_state,
            agents::agent_escalation_decide,
            agent_runtime::agent_runtime_tasks,
            agent_runtime::agent_runtime_activity,
            agent_runtime::agent_cancel_run,
            agent_runtime::agent_trace,
            agent_runtime::agent_plan_get,
            agent_skills::agentskill_list,
            agent_skills::agentskill_get,
            agent_skills::agentskill_save,
            agent_skills::agentskill_delete,
            agent_skills::agentskill_import,
            agent_skills::agentskill_export,
            skills::skill_versions,
            skills::skill_rollback,
            skills::skill_improve,
            skills::skill_validate,
            evolution::eval_corpus_build,
            evolution::eval_corpus_list,
            evolution::eval_case_add,
            evolution::eval_case_delete,
            evolution::skill_score,
            evolution::skill_optimize,
            evolution::agent_instruction_optimize,
            evolution::agent_instruction_versions,
            evolution::agent_instruction_rollback,
            evolution::evolution_overview,
            llmlog::llm_log_list,
            llmlog::llm_log_clear,
            llmlog::llm_log_push,
            app_windows::open_llm_log,
            village_assets::village_assets_list,
            village_assets::village_asset_import,
            village_assets::village_asset_delete,
            village_assets::village_layout_load,
            village_assets::village_layout_save,
            avatar_glb::avatar_glb_import,
            avatar_glb::avatar_glb_status,
            avatar_glb::avatar_glb_load,
            avatar_glb::avatar_glb_delete,
            agents::set_ollama_config,
            agents::llm_secret_status,
            agents::llm_api_models,
            agents::llm_cloud_models,
            agents::llm_clear_api_key,
            agents::llm_api_profiles,
            companion::robot_bridge_info,
            agents::llm_api_profile_save,
            agents::llm_api_profile_delete,
            agents::llm_api_profile_activate,
            agents::llm_api_select,
            agents::llm_api_profile_models,
            agents::llm_api_request,
            llm_stream::llm_stream,
            llm_stream::llm_stream_cancel,
            dictate,
            platform_flavor,
            gpu_flavor,
            atelier_enabled,
            pro_enabled,
            license::license_status,
            license::license_activate,
            license::license_clear,
            appperms::perm_get,
            appperms::perm_list,
            appperms::perm_set,
            appperms::perm_reset,
            appstore::app_list,
            appstore::app_install,
            appstore::app_uninstall,
            appstore::app_asset,
            appstore::app_updates,
            appstore::store_index,
            appstore::store_repo_url,
            appstore::store_set_repo,
            product_name,
            meet::meet_host,
            meet::meet_open_room,
            meet::meet_close_room,
            meet::meet_rooms,
            dbshare::dbshare_list,
            dbshare::dbshare_save,
            dbshare::dbshare_delete,
            dbshare::dbshare_open,
            dbshare::dbshare_rows,
            dbshare::dbshare_insert,
            dbshare::dbshare_update,
            dbshare::dbshare_delete_row,
            dbshare::dbshare_relation_options,
            netserver::netserver_state,
            netserver::netserver_link,
            netserver::netserver_unlink,
            netserver::netserver_api,
            netserver::netserver_keys,
            netserver::netserver_connect,
            netserver::netserver_disconnect,
            netserver::netserver_send,
            datasources::datasources_kinds,
            datasources::datasources_list,
            datasources::datasources_save,
            datasources::datasources_delete,
            datasources::datasources_ping,
            datasources::datasources_datasets,
            datasources::datasources_schema,
            datasources::datasources_rows,
            datasources::datasources_objects,
            datasources::datasources_object,
            datasources::datasources_query,
            datasources::server::datasources_server_start,
            datasources::server::datasources_server_status,
            datasources::server::datasources_openapi,
            pro_db::prodb_pg_ping,
            pro_db::prodb_pg_schema,
            pro_db::prodb_pg_query,
            pro_db::prodb_pg_exec,
            pro_db::prodb_pg_migrate,
            tts::tts_catalog,
            tts::tts_installed,
            tts::tts_active_voice,
            tts::tts_set_voice,
            tts::tts_get_tuning,
            tts::tts_set_tuning,
            tts::tts_tuning_limits,
            tts::tts_voice_speakers,
            tts::tts_download_voice,
            tts::tts_delete_voice,
            tts::tts_speak,
            tts::tts_runtime_available,
            tts::tts_engine_status,
            tts::tts_install_runtime,
            tts::tts_speak_macos,
            tts::tts_export_wav,
            tts::tts_synth_b64,
            tts::tts_send_to_orb,
            tts::tts_stop,
            dispatch_action,
            memory::memory_get,
            memory::memory_set,
            memory::memory_delete,
            memory::memory_list,
            recall::mem_remember,
            recall::mem_recall,
            recall::mem_list,
            recall::mem_stats,
            recall::mem_update,
            recall::mem_forget,
            recall::mem_wipe,
            recall::mem_policy_get,
            recall::mem_policy_set,
            recall::mem_consolidate,
            app_windows::open_memory,
            app_windows::open_vault,
            auth::companion_auth_info,
            auth::companion_auth_profiles,
            auth::companion_regenerate_secret,
            app_windows::open_messenger,
            messenger::messenger_contacts,
            messenger::messenger_threads,
            messenger::messenger_thread,
            messenger::messenger_new,
            messenger::messenger_send,
            messenger::messenger_cut,
            messenger::messenger_stop,
            messenger::messenger_delete,
            messenger::messenger_update,
            messenger::messenger_tools,
            messenger::messenger_file,
            apns::apns_status,
            apns::apns_configure,
            apns::apns_clear,
            apns::apns_test,
            devices::devices_list,
            devices::device_revoke,
            devices::device_rename,
            devices::security_log,
            devices::unlock_policy_get,
            devices::unlock_policy_set,
            autobackup::autobackup_get,
            autobackup::autobackup_set,
            autobackup::autobackup_run_now,
            vault::vault_list,
            vault::vault_workspace,
            vault::vault_sources,
            vault::vault_files,
            vault::vault_source_get,
            vault::vault_collection_save,
            vault::vault_records_save,
            vault::vault_records_query,
            vault::vault_record_delete,
            datahub::datahub_overview,
            datahub::datahub_settings_set,
            datahub::datahub_reindex,
            datahub::datahub_query,
            datahub::datahub_open_file,
            vault::vault_get,
            vault::vault_set,
            vault::vault_append,
            vault::vault_delete,
            native_tools::native_tool_exec,
            native_tools::nodal_tool_exec,
            session::session_lock_status,
            session::session_set_enabled,
            session::session_set_password,
            session::session_clear_password,
            session::session_unlock,
            session::session_set_rfid,
            session::session_clear_rfid,
            session::session_unlock_rfid,
            volume::system_set_volume,
            screen::capture_screen,
            screen::screen_mirror_frame,
            screen::screen_select_open,
            screen::screen_select_preview,
            screen::screen_select_finish,
            screen::screen_select_cancel,
            rfid_store::rfid_bindings_list,
            rfid_store::rfid_bind,
            rfid_store::rfid_unbind,
            rfid_store::rfid_resolve,
            rfid_store::rfid_import_legacy,
            session::session_lock,
            session::session_is_unlocked,
            session::session_active_profile_id,
            session::session_profiles,
            session::session_save_profile,
            session::session_set_active_profile,
            session::session_delete_profile,
            companion::companion_start,
            companion::companion_stop,
            companion::companion_status,
            companion::remote_broadcast,
            companion::run_events,
            companion::clear_run
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Les processus tiers lancés par Lumen (serveurs MCP, llama-server)
            // ne doivent pas survivre à la fermeture de l'application. Un
            // llama-server orphelin garderait le port 11435 et empêcherait la
            // session suivante de charger le modèle demandé.
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                if let Some(state) = app.try_state::<mcp::McpState>() {
                    mcp::shutdown(&state);
                }
                if let Some(state) = app.try_state::<litert::LitertState>() {
                    litert::shutdown(&state);
                }
                if let Some(state) = app.try_state::<applefm::AppleFmState>() {
                    applefm::shutdown(&state);
                }
                if let Some(state) = app.try_state::<llama::LlamaState>() {
                    llama::shutdown(&state);
                    whisper::shutdown();
                    rerank::shutdown();
                }
                if let Some(state) = app.try_state::<bonsai::BonsaiState>() {
                    bonsai::shutdown(&state);
                }
            }
        });
}

fn start_server_agent_worker(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(12)).await;
            if !(cfg!(feature = "pro") && license::is_pro(&app)) { continue; }
            let link = netserver::read_link(&app);
            if link.url.is_empty() || link.token.is_empty() { continue; }

            let claim_app = app.clone();
            let claimed = tauri::async_runtime::spawn_blocking(move || {
                netserver::netserver_api(claim_app, "POST".into(), "/v1/runs/claim".into(), Some(serde_json::json!({})))
            }).await;
            let payload = match claimed { Ok(Ok(value)) => value, _ => continue };
            let Some(run) = payload.get("run").filter(|v| !v.is_null()) else { continue };
            let run_id = run.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
            let agent_id = run.get("agent_id").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
            let input = run.get("input").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
            let spec = payload.get("agent").and_then(|v| v.get("spec")).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
            if run_id.is_empty() { continue; }
            if agent_id.is_empty() || spec.is_empty() {
                let finish_app = app.clone();
                let body = serde_json::json!({ "success": false, "result": "La tâche réservée ne contient pas une définition d'agent complète." });
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    netserver::netserver_api(finish_app, "POST".into(), format!("/v1/runs/{run_id}/finish"), Some(body))
                }).await;
                continue;
            }

            let alive = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
            let heartbeat_alive = alive.clone();
            let heartbeat_app = app.clone();
            let heartbeat_id = run_id.clone();
            let heartbeat = std::thread::spawn(move || {
                while heartbeat_alive.load(std::sync::atomic::Ordering::Relaxed) {
                    for _ in 0..30 {
                        if !heartbeat_alive.load(std::sync::atomic::Ordering::Relaxed) { return; }
                        std::thread::sleep(std::time::Duration::from_secs(1));
                    }
                    let _ = netserver::netserver_api(heartbeat_app.clone(), "POST".into(), format!("/v1/runs/{heartbeat_id}/heartbeat"), None);
                }
            });

            let execute_app = app.clone();
            let execution = tauri::async_runtime::spawn_blocking(move || {
                agents::execute_server_agent(&execute_app, &agent_id, &spec, &input)
            }).await;
            alive.store(false, std::sync::atomic::Ordering::Relaxed);
            let _ = heartbeat.join();
            let (success, result) = match execution {
                Ok(Ok(output)) if !output.starts_with("Escalade :") => (true, output),
                Ok(Ok(output)) => (false, output),
                Ok(Err(error)) => (false, error),
                Err(error) => (false, format!("Worker interrompu : {error}")),
            };
            let finish_app = app.clone();
            let body = serde_json::json!({ "success": success, "result": result });
            let _ = tauri::async_runtime::spawn_blocking(move || {
                netserver::netserver_api(finish_app, "POST".into(), format!("/v1/runs/{run_id}/finish"), Some(body))
            }).await;
        }
    });
}

#[cfg(test)]
mod web_fetch_tests {
    use super::*;

    const NOISE: &str = r#"<nav class="site-nav"><a href="/a">Accueil</a><a href="/b">Blog</a><a href="/c">Tarifs</a></nav>"#;

    fn long_paragraph(marker: &str) -> String {
        format!("<p>{marker} {}</p>", "du contenu rédactionnel bien réel. ".repeat(40))
    }

    #[test]
    fn garde_l_article_et_ecarte_la_navigation() {
        let html = format!(
            "<html><body>{NOISE}<article>{}</article><footer><a href='/x'>Mentions</a></footer></body></html>",
            long_paragraph("CORPS")
        );
        let main = readable_html(&html);
        assert!(main.contains("CORPS"), "le corps de l'article doit être conservé");
        assert!(!main.contains("Tarifs"), "la navigation ne doit pas être retenue");
    }

    #[test]
    fn reconnait_un_div_de_contenu_sans_balise_semantique() {
        let html = format!(
            "<html><body>{NOISE}<div class=\"post-content\">{}</div></body></html>",
            long_paragraph("CORPS")
        );
        let main = readable_html(&html);
        assert!(main.contains("CORPS"));
        assert!(!main.contains("Accueil"));
    }

    #[test]
    fn ignore_les_blocs_de_commentaires() {
        let html = format!(
            "<html><body><div class=\"post-comments\">{}</div></body></html>",
            long_paragraph("COMMENTAIRE")
        );
        // Aucun candidat retenu : on retombe sur le document entier plutôt que
        // de présenter les commentaires comme l'article.
        let main = readable_html(&html);
        assert!(main.contains("<body>"), "repli attendu sur le document complet");
    }

    #[test]
    fn une_page_tout_en_liens_retombe_sur_le_document() {
        let links: String = (0..80)
            .map(|i| format!("<a href='/r{i}'>Un résultat de recherche numéro {i}</a> "))
            .collect();
        let html = format!("<html><body><div class=\"content\">{links}</div></body></html>");
        let main = readable_html(&html);
        // Densité de liens trop forte pour être un article : pas d'amputation.
        assert!(main.contains("<body>"));
        assert!(main.contains("/r79"));
    }

    #[test]
    fn prefere_la_balise_semantique_au_conteneur_englobant() {
        let html = format!(
            "<html><body><div class=\"main-wrapper\">{NOISE}<article>{}</article>{}</div></body></html>",
            long_paragraph("CORPS"),
            long_paragraph("ENCART LATERAL")
        );
        let main = readable_html(&html);
        assert!(main.contains("CORPS"));
        assert!(!main.contains("ENCART LATERAL"), "l'article doit primer sur le wrapper");
    }

    #[test]
    fn html_mal_ferme_ne_panique_pas() {
        let html = format!("<body><div class=\"content\"><article>{}", long_paragraph("CORPS"));
        let _ = readable_html(&html);
    }

    #[test]
    fn densite_de_liens_calculee_sur_le_texte_visible() {
        let (text, link) = text_and_link_len("<p>abcd <a href='#'>ef</a></p>");
        assert_eq!(text, 6);
        assert_eq!(link, 2);
    }

    #[test]
    fn titre_pdf_derive_de_l_url() {
        assert_eq!(pdf_title_from_url("https://x.org/docs/mon_rapport-2026.pdf"), "mon rapport 2026");
        assert_eq!(pdf_title_from_url("https://x.org/"), "Document PDF");
    }
}
