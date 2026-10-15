//! Stockage : état des apps sur disque, inventaire de l'espace, sauvegarde à la carte.
//!
//! Deux problèmes réglés ici.
//!
//! 1. **L'état des apps quittait rarement le navigateur.** Plusieurs apps
//!    persistaient dans `localStorage`, un budget d'environ 10 Mo partagé par
//!    TOUTES les fenêtres de Lumen (même origine `tauri://localhost`). Un seul
//!    moodboard illustré le saturait, et toute écriture échouait ensuite —
//!    y compris celles qui n'avaient rien à voir. `app_state_*` donne à chaque
//!    app un fichier JSON dans `app-state/`, sans plafond commun.
//!
//! 2. **Personne ne savait ce qui occupait le disque.** `storage_report`
//!    ventile `app_data_dir` en catégories lisibles (sandboxes, modèles, voix,
//!    mémoire…), à la façon du panneau « Stockage » de macOS, et sert aussi de
//!    liste de cases à cocher pour la sauvegarde sélective.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())
}

// ===================== État des apps =====================

/// Nom de fichier sûr pour une app : jamais de séparateur ni de `..`, donc
/// jamais d'écriture hors de `app-state/`.
fn state_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let clean: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if clean.is_empty() {
        return Err("Nom d'app invalide".into());
    }
    let dir = data_dir(app)?.join("app-state");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{clean}.json")))
}

/// Lit l'état d'une app. Chaîne vide si l'app n'a rien enregistré.
#[tauri::command]
pub fn app_state_load(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let path = state_file(&app, &name)?;
    Ok(fs::read_to_string(path).unwrap_or_default())
}

/// Remplace l'état d'une app. L'écriture passe par un fichier temporaire :
/// une coupure en cours d'écriture ne laisse pas un JSON tronqué.
#[tauri::command]
pub fn app_state_save(app: tauri::AppHandle, name: String, data: String) -> Result<(), String> {
    let path = state_file(&app, &name)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    crate::datahub::touch(&app);
    Ok(())
}

/// Oublie l'état d'une app.
#[tauri::command]
pub fn app_state_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let path = state_file(&app, &name)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Inventaire de `app-state/` : nom et taille de chaque état enregistré.
#[tauri::command]
pub fn app_state_list(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = data_dir(&app)?.join("app-state");
    let mut items = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            items.push(serde_json::json!({ "name": name, "bytes": bytes }));
        }
    }
    Ok(serde_json::Value::Array(items))
}

// ===================== Inventaire de l'espace =====================

/// Une catégorie de stockage : ce que l'utilisateur reconnaît, pas l'arborescence.
/// `id` sert de clé pour la sauvegarde sélective et la suppression.
struct Category {
    id: &'static str,
    label: &'static str,
    /// Peut-elle entrer dans une sauvegarde ? (les runtimes se retéléchargent)
    backupable: bool,
    /// L'utilisateur peut-il la vider depuis l'app Stockage ?
    clearable: bool,
    /// Premiers segments de chemin qui appartiennent à cette catégorie.
    paths: &'static [&'static str],
}

/// L'ordre est celui de l'affichage : du plus lourd au plus anecdotique en
/// pratique, les runtimes en tête.
const CATEGORIES: &[Category] = &[
    Category { id: "sandboxes", label: "Sandboxes", backupable: true, clearable: false,
        paths: &["sandboxes"] },
    Category { id: "models", label: "Modèles IA", backupable: false, clearable: true,
        paths: &["models", "llama-cache"] },
    Category { id: "voices", label: "Voix", backupable: false, clearable: true,
        paths: &["piper-runtime", "piper-voices", "kokoro", "tts.json"] },
    Category { id: "images", label: "Génération d'images", backupable: false, clearable: true,
        paths: &["bonsai-image-demo", "bonsai-official-venv"] },
    Category { id: "knowledge", label: "Connaissances", backupable: true, clearable: true,
        paths: &["rag.db"] },
    Category { id: "memory", label: "Mémoire", backupable: true, clearable: false,
        paths: &["memory.json", "recall", "session_profiles.json", "profiles"] },
    Category { id: "tables", label: "Bases de données", backupable: true, clearable: false,
        paths: &["tables.db"] },
    Category { id: "agents", label: "Agents & automatisations", backupable: true, clearable: false,
        paths: &["agents.json", "agent_runtime.db", "agent_activity.json", "agent_runs.json",
                 "skill_health", "instruction_versions", "workflows"] },
    Category { id: "appstate", label: "État des apps", backupable: true, clearable: false,
        paths: &["app-state"] },
    Category { id: "apps", label: "Réglages des apps", backupable: true, clearable: false,
        paths: &["inbox.json", "kanban.json", "reminders.json", "domotique.json",
                 "village_layout.json", "prompt_defaults.json", "mcp.json", "rfid_bindings.json",
                 "ollama.json", "web_tools.json", "companion_auth.json", "avatar"] },
    Category { id: "logs", label: "Journaux & diagnostics", backupable: false, clearable: true,
        paths: &["window-diagnostics.log", "llm_log.json", "session_lock.json",
                 "llama-ctx-size.txt"] },
];

fn category_of(rel: &str) -> &'static str {
    let first = rel.split('/').next().unwrap_or("");
    for c in CATEGORIES {
        if c.paths.contains(&first) {
            return c.id;
        }
    }
    "other"
}

/// Taille récursive d'un chemin (fichier ou dossier).
fn path_size(p: &Path) -> u64 {
    let Ok(meta) = fs::metadata(p) else { return 0 };
    if meta.is_file() {
        return meta.len();
    }
    let mut total = 0;
    if let Ok(entries) = fs::read_dir(p) {
        for e in entries.flatten() {
            total += path_size(&e.path());
        }
    }
    total
}

/// Ventilation de l'espace occupé par Lumen, plus l'espace libre du disque.
/// C'est la source unique de l'app « Stockage » : mêmes catégories pour
/// l'affichage, la sauvegarde sélective et le nettoyage.
#[tauri::command]
pub async fn storage_report(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // Le parcours pèse plusieurs gigaoctets de métadonnées : sur le thread
    // principal, il fige l'interface le temps du calcul.
    tauri::async_runtime::spawn_blocking(move || storage_report_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn storage_report_blocking(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let root = data_dir(app)?;
    let mut sizes: std::collections::HashMap<&'static str, u64> = std::collections::HashMap::new();
    let mut other_items: Vec<serde_json::Value> = Vec::new();

    if let Ok(entries) = fs::read_dir(&root) {
        for e in entries.flatten() {
            let path = e.path();
            let rel = path
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if rel.is_empty() {
                continue;
            }
            let size = path_size(&path);
            let cat = category_of(&rel);
            *sizes.entry(cat).or_insert(0) += size;
            if cat == "other" && size > 0 {
                other_items.push(serde_json::json!({ "name": rel, "bytes": size }));
            }
        }
    }

    let mut cats: Vec<serde_json::Value> = CATEGORIES
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "label": c.label,
                "bytes": sizes.get(c.id).copied().unwrap_or(0),
                "backupable": c.backupable,
                "clearable": c.clearable,
            })
        })
        .collect();
    other_items.sort_by(|a, b| b["bytes"].as_u64().cmp(&a["bytes"].as_u64()));
    cats.push(serde_json::json!({
        "id": "other", "label": "Divers",
        "bytes": sizes.get("other").copied().unwrap_or(0),
        "backupable": true, "clearable": false,
        "items": other_items,
    }));

    let total: u64 = cats.iter().filter_map(|c| c["bytes"].as_u64()).sum();
    let (disk_total, disk_free) = disk_space(&root);

    Ok(serde_json::json!({
        "root": root.to_string_lossy(),
        "total": total,
        "categories": cats,
        "disk_total": disk_total,
        "disk_free": disk_free,
    }))
}

/// Espace total et libre du volume qui héberge `path`. 0 si l'appel système
/// échoue (l'interface masque alors la jauge disque, sans rien inventer).
#[cfg(unix)]
fn disk_space(path: &Path) -> (u64, u64) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { return (0, 0) };
    unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut st) != 0 {
            return (0, 0);
        }
        let frsize = st.f_frsize as u64;
        (st.f_blocks as u64 * frsize, st.f_bavail as u64 * frsize)
    }
}

#[cfg(not(unix))]
fn disk_space(_path: &Path) -> (u64, u64) {
    (0, 0)
}

/// Vide une catégorie nettoyable (modèles, voix, journaux…). Les catégories de
/// données personnelles ne sont pas nettoyables ici : leur suppression passe
/// par l'app concernée, où l'utilisateur voit ce qu'il retire.
#[tauri::command]
pub async fn storage_clear(app: tauri::AppHandle, category: String) -> Result<u64, String> {
    // Vider « Génération d'images », c'est supprimer un environnement Python de
    // plus d'un gigaoctet : hors du thread principal, sinon la fenêtre se fige
    // et le clic paraît sans effet.
    tauri::async_runtime::spawn_blocking(move || storage_clear_blocking(&app, &category))
        .await
        .map_err(|e| e.to_string())?
}

fn storage_clear_blocking(app: &tauri::AppHandle, category: &str) -> Result<u64, String> {
    let cat = CATEGORIES
        .iter()
        .find(|c| c.id == category)
        .ok_or_else(|| format!("Catégorie inconnue : {category}"))?;
    if !cat.clearable {
        return Err(format!("« {} » ne se vide pas depuis ici.", cat.label));
    }
    let root = data_dir(app)?;
    let mut freed = 0u64;
    for p in cat.paths {
        let path = root.join(p);
        if !path.exists() {
            continue;
        }
        freed += path_size(&path);
        let res = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        res.map_err(|e| format!("{p} : {e}"))?;
    }
    Ok(freed)
}

/// Nettoyage des journaux de diagnostic (app Diagnostic). `targets` :
///   - `window`  : window-diagnostics.log (erreurs JS et WebView) ;
///   - `llm`     : journal des appels de modèles (llm_log.json) ;
///   - `servers` : journaux des serveurs IA (llama-*, bonsai…) et halo.log.
/// Les journaux des serveurs sont TRONQUÉS, pas supprimés : un llama-server en
/// marche garde son fichier ouvert et continuerait d'écrire dans le vide.
#[tauri::command]
pub async fn diagnostic_logs_clear(app: tauri::AppHandle, targets: Vec<String>) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut freed = 0u64;
        let want = |t: &str| targets.iter().any(|x| x == t || x == "all");
        if want("window") {
            let path = data_dir(&app)?.join("window-diagnostics.log");
            if path.exists() {
                freed += path_size(&path);
                fs::remove_file(&path).map_err(|e| format!("window-diagnostics.log : {e}"))?;
            }
        }
        if want("llm") {
            let path = data_dir(&app)?.join("llm_log.json");
            freed += if path.exists() { path_size(&path) } else { 0 };
            crate::llmlog::llm_log_clear(app.clone())?;
        }
        if want("servers") {
            let mut dirs: Vec<PathBuf> = Vec::new();
            if let Ok(d) = crate::paths::shared_log_dir(app.path()) { dirs.push(d); }
            if let Ok(home) = std::env::var("HOME") { dirs.push(Path::new(&home).join("Library/Logs/Lumen")); }
            for dir in dirs {
                let Ok(rd) = fs::read_dir(&dir) else { continue };
                for e in rd.flatten() {
                    let p = e.path();
                    if p.extension().and_then(|x| x.to_str()) != Some("log") || !p.is_file() {
                        continue;
                    }
                    freed += path_size(&p);
                    if let Ok(f) = fs::OpenOptions::new().write(true).open(&p) {
                        let _ = f.set_len(0);
                    }
                }
            }
        }
        Ok(freed)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Taille actuelle des journaux, par cible (affichée avant nettoyage).
#[tauri::command]
pub fn diagnostic_logs_size(app: tauri::AppHandle) -> serde_json::Value {
    let size = |p: PathBuf| if p.exists() { path_size(&p) } else { 0 };
    let root = data_dir(&app).ok();
    let mut servers = 0u64;
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(d) = crate::paths::shared_log_dir(app.path()) { dirs.push(d); }
    if let Ok(home) = std::env::var("HOME") { dirs.push(Path::new(&home).join("Library/Logs/Lumen")); }
    for dir in dirs {
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("log") { servers += size(p); }
            }
        }
    }
    serde_json::json!({
        "window": root.as_ref().map(|r| size(r.join("window-diagnostics.log"))).unwrap_or(0),
        "llm": root.as_ref().map(|r| size(r.join("llm_log.json"))).unwrap_or(0),
        "servers": servers,
    })
}

/// Catégories retenues pour une sauvegarde → premiers segments de chemin
/// correspondants. Utilisé par `backup::backup_export_selection`.
pub fn paths_for_categories(ids: &[String]) -> Vec<&'static str> {
    let mut out = Vec::new();
    for c in CATEGORIES {
        if ids.iter().any(|id| id == c.id) {
            out.extend_from_slice(c.paths);
        }
    }
    out
}

/// Une catégorie existe-t-elle et est-elle sauvegardable ?
pub fn is_backupable(id: &str) -> bool {
    CATEGORIES.iter().any(|c| c.id == id && c.backupable) || id == "other"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_les_chemins_dans_la_bonne_categorie() {
        assert_eq!(category_of("sandboxes/abc/root/x.png"), "sandboxes");
        assert_eq!(category_of("rag.db"), "knowledge");
        assert_eq!(category_of("app-state/moodboard.json"), "appstate");
        assert_eq!(category_of("window-diagnostics.log"), "logs");
        assert_eq!(category_of("un-fichier-inconnu.json"), "other");
    }

    #[test]
    fn la_selection_de_sauvegarde_liste_les_chemins() {
        let paths = paths_for_categories(&["knowledge".to_string(), "tables".to_string()]);
        assert!(paths.contains(&"rag.db"));
        assert!(paths.contains(&"tables.db"));
        assert!(!paths.contains(&"models"));
    }

    #[test]
    fn les_runtimes_ne_sont_pas_sauvegardables() {
        assert!(!is_backupable("models"));
        assert!(!is_backupable("voices"));
        assert!(is_backupable("memory"));
    }
}
