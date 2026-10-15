//! A small, independent prompt window. Never opens the desktop or chat history.
use tauri::{Emitter, Manager};

pub(crate) fn toggle(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("quick-prompt") {
        if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
            let _ = window.emit("quick-prompt-hidden", ());
            window.hide().map_err(|e| e.to_string())?;
        } else {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            let _ = window.emit("quick-prompt-focus", ());
        }
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(app, "quick-prompt", tauri::WebviewUrl::App("quick-prompt.html".into()))
        .title("Lumen — Accès rapide")
        .inner_size(560.0, 128.0)
        .min_inner_size(320.0, 128.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .center()
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn quick_prompt_toggle(app: tauri::AppHandle) -> Result<(), String> { toggle(&app) }

#[tauri::command]
pub(crate) fn quick_prompt_hide(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "quick-prompt" { return Err("Fenêtre d’accès rapide attendue.".into()); }
    let _ = window.emit("quick-prompt-hidden", ());
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn quick_prompt_resize(window: tauri::WebviewWindow, height: f64) -> Result<(), String> {
    if window.label() != "quick-prompt" || !height.is_finite() { return Err("Dimensions invalides.".into()); }
    window.set_size(tauri::LogicalSize::new(560.0, height.clamp(128.0, 380.0))).map_err(|e| e.to_string())
}
