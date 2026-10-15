//! Sauvegarde et restauration globales (« la sortie de secours »).
//!
//! Tout l'état utilisateur de Lumen vit dans `app_data_dir` : bases SQLite
//! (`tables.db`, `rag.db`, `agent_runtime.db`), JSON (agents, inbox, kanban,
//! mémoire, profils…) et les sandboxes. Ce module en produit une archive ZIP
//! unique `.lumenbackup` que l'utilisateur peut emporter, et sait la relire.
//!
//! Ce qui est volontairement EXCLU : les runtimes retéléchargeables (modèles
//! GGUF, voix Piper/Kokoro, venv Bonsai) et les journaux de diagnostic. Ils
//! pèsent des gigaoctets et se reconstituent tout seuls ; les inclure rendrait
//! la sauvegarde inutilisable en pratique.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Dossiers (à la racine de `app_data_dir`) exclus de la sauvegarde : contenus
/// retéléchargeables ou régénérables. Comparaison sur le premier segment du
/// chemin relatif.
const EXCLUDED_DIRS: &[&str] = &[
    "models",
    "piper-runtime",
    "piper-voices",
    "kokoro",
    "bonsai-image-demo",
    "bonsai-official-venv",
    "llama-cache",
];

/// Fichiers exclus : journaux et verrous de session, sans valeur après coup.
const EXCLUDED_FILES: &[&str] = &[
    "window-diagnostics.log",
    "session_lock.json",
    "llama-ctx-size.txt",
];

/// Version du format d'archive. Incrémenter si la disposition change de façon
/// incompatible ; `backup_import` refuse une version qu'il ne connaît pas.
const FORMAT_VERSION: u32 = 1;

const MANIFEST_NAME: &str = "lumen-backup.json";

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Manifest {
    pub format: u32,
    pub app_version: String,
    pub created_at: String,
    pub platform: String,
    pub files: usize,
    pub bytes: u64,
}

#[derive(serde::Serialize)]
pub struct BackupSummary {
    pub path: String,
    pub files: usize,
    /// Taille des données brutes avant compression.
    pub bytes: u64,
    /// Taille réelle de l'archive sur le disque.
    pub archive_bytes: u64,
    /// Entrées ignorées (runtimes, journaux), pour affichage.
    pub skipped: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct RestoreSummary {
    pub files: usize,
    pub bytes: u64,
    pub created_at: String,
    pub app_version: String,
    /// Archive de sécurité de l'état PRÉCÉDENT, écrite avant d'écraser quoi que
    /// ce soit. Permet de revenir en arrière si la restauration déçoit.
    pub rollback_path: String,
}

fn now_iso() -> String {
    chrono::Local::now().to_rfc3339()
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())
}

/// Un chemin relatif doit-il être ignoré ? On teste le premier segment pour les
/// dossiers (ce qui exclut toute leur descendance) et le chemin complet pour
/// les fichiers de la racine.
fn is_excluded(rel: &str) -> bool {
    let first = rel.split('/').next().unwrap_or("");
    EXCLUDED_DIRS.contains(&first) || EXCLUDED_FILES.contains(&rel)
}

/// Parcours récursif de `dir`, en accumulant les chemins relatifs à `root`.
fn walk(root: &Path, dir: &Path, out: &mut Vec<(PathBuf, String)>, skipped: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(rel_path) = path.strip_prefix(root) else { continue };
        let rel = rel_path.to_string_lossy().replace('\\', "/");
        if rel.is_empty() {
            continue;
        }
        if is_excluded(&rel) {
            skipped.push(rel);
            continue;
        }
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => walk(root, &path, out, skipped),
            Ok(ft) if ft.is_file() => out.push((path, rel)),
            // Les liens symboliques ne sont pas suivis : une sauvegarde ne doit
            // jamais sortir de `app_data_dir`.
            _ => {}
        }
    }
}

/// Estime le contenu d'une sauvegarde sans rien écrire : sert à afficher
/// « 34 fichiers, 12,4 Mo » avant que l'utilisateur ne confirme.
#[tauri::command]
pub fn backup_estimate(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let root = data_dir(&app)?;
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    walk(&root, &root, &mut files, &mut skipped);
    let bytes: u64 = files
        .iter()
        .filter_map(|(p, _)| fs::metadata(p).ok().map(|m| m.len()))
        .sum();
    Ok(serde_json::json!({
        "files": files.len(),
        "bytes": bytes,
        "skipped": skipped,
        "root": root.to_string_lossy(),
    }))
}

/// Écrit une archive `.lumenbackup`. `dest_dir` vide → dossier de
/// téléchargements, puis bureau, puis dossier personnel.
#[tauri::command]
pub fn backup_export(app: tauri::AppHandle, dest_dir: String) -> Result<BackupSummary, String> {
    let root = data_dir(&app)?;
    let dir = if dest_dir.trim().is_empty() {
        app.path()
            .download_dir()
            .or_else(|_| app.path().desktop_dir())
            .or_else(|_| app.path().home_dir())
            .map_err(|e| e.to_string())?
    } else {
        PathBuf::from(dest_dir.trim())
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M");
    let dest = dir.join(format!("Lumen_{stamp}.lumenbackup"));
    let summary = write_archive(&app, &root, &dest)?;
    Ok(summary)
}

/// Export à la carte : l'utilisateur choisit les catégories (app Stockage).
/// Une liste vide revient à tout prendre, comme `backup_export`.
#[tauri::command]
pub fn backup_export_selection(
    app: tauri::AppHandle,
    dest_dir: String,
    categories: Vec<String>,
) -> Result<BackupSummary, String> {
    let root = data_dir(&app)?;
    let dir = if dest_dir.trim().is_empty() {
        app.path()
            .download_dir()
            .or_else(|_| app.path().desktop_dir())
            .or_else(|_| app.path().home_dir())
            .map_err(|e| e.to_string())?
    } else {
        PathBuf::from(dest_dir.trim())
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let wanted: Vec<String> = categories
        .into_iter()
        .filter(|c| crate::storage::is_backupable(c))
        .collect();
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M");
    let dest = dir.join(format!("Lumen_{stamp}.lumenbackup"));
    if wanted.is_empty() {
        return write_archive(&app, &root, &dest);
    }
    let allow = crate::storage::paths_for_categories(&wanted);
    write_archive_filtered(&app, &root, &dest, Some(&allow))
}

/// Estime une sauvegarde à la carte, sans rien écrire.
#[tauri::command]
pub fn backup_estimate_selection(
    app: tauri::AppHandle,
    categories: Vec<String>,
) -> Result<serde_json::Value, String> {
    let root = data_dir(&app)?;
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    walk(&root, &root, &mut files, &mut skipped);
    let wanted: Vec<String> = categories
        .into_iter()
        .filter(|c| crate::storage::is_backupable(c))
        .collect();
    if !wanted.is_empty() {
        let allow = crate::storage::paths_for_categories(&wanted);
        files.retain(|(_, rel)| {
            let first = rel.split('/').next().unwrap_or("");
            allow.contains(&first) || allow.contains(&rel.as_str())
        });
    }
    let bytes: u64 = files
        .iter()
        .filter_map(|(p, _)| fs::metadata(p).ok().map(|m| m.len()))
        .sum();
    Ok(serde_json::json!({ "files": files.len(), "bytes": bytes }))
}

/// Cœur de l'export, réutilisé par `backup_import` pour l'archive de
/// sécurité pré-restauration.
fn write_archive(
    app: &tauri::AppHandle,
    root: &Path,
    dest: &Path,
) -> Result<BackupSummary, String> {
    write_archive_filtered(app, root, dest, None)
}

/// Variante à la carte : `only` limite l'archive aux premiers segments de
/// chemin retenus (cf. `storage::paths_for_categories`). `None` = tout, comme
/// avant. Sauvegarder « juste mes notes et ma mémoire » avant une manipulation
/// risquée vaut mieux qu'une archive de plusieurs gigaoctets qu'on ne fait
/// jamais.
fn write_archive_filtered(
    app: &tauri::AppHandle,
    root: &Path,
    dest: &Path,
    only: Option<&[&str]>,
) -> Result<BackupSummary, String> {
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    walk(root, root, &mut files, &mut skipped);
    if let Some(allow) = only {
        files.retain(|(_, rel)| {
            let first = rel.split('/').next().unwrap_or("");
            let keep = allow.contains(&first) || allow.contains(&rel.as_str());
            if !keep {
                skipped.push(rel.clone());
            }
            keep
        });
    }

    let file = fs::File::create(dest).map_err(|e| format!("Création de l'archive : {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut bytes = 0u64;
    let mut buf = Vec::new();
    for (path, rel) in &files {
        // Un fichier qui disparaît en cours de route (base SQLite en rotation,
        // fichier temporaire) ne doit pas faire échouer toute la sauvegarde.
        let Ok(mut f) = fs::File::open(path) else { continue };
        buf.clear();
        if f.read_to_end(&mut buf).is_err() {
            continue;
        }
        zip.start_file(format!("data/{rel}"), options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&buf).map_err(|e| e.to_string())?;
        bytes += buf.len() as u64;
    }

    let manifest = Manifest {
        format: FORMAT_VERSION,
        app_version: app.package_info().version.to_string(),
        created_at: now_iso(),
        platform: std::env::consts::OS.to_string(),
        files: files.len(),
        bytes,
    };
    zip.start_file(MANIFEST_NAME, options)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;

    let archive_bytes = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    Ok(BackupSummary {
        path: dest.to_string_lossy().to_string(),
        files: files.len(),
        bytes,
        archive_bytes,
        skipped,
    })
}

/// Écrit l'archive complète à un chemin donné (sauvegarde automatique).
pub fn export_to(app: &tauri::AppHandle, dest: &Path) -> Result<(), String> {
    let root = data_dir(app)?;
    write_archive(app, &root, dest).map(|_| ())
}

/// Archive chiffrée (`.lumenbackup.enc`) → copie en clair temporaire, avec
/// la phrase secrète. Une archive en clair est rendue telle quelle.
fn resolve_plain(path: &str, passphrase: Option<&str>) -> Result<String, String> {
    let src = Path::new(path);
    if !crate::autobackup::is_encrypted(src) {
        return Ok(path.to_string());
    }
    let pass = passphrase
        .filter(|p| !p.is_empty())
        .ok_or("Sauvegarde chiffrée : saisis sa phrase secrète.")?;
    let dir = std::env::temp_dir().join("lumen-restore");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join("decrypted.lumenbackup");
    crate::autobackup::decrypt_file(src, &dest, pass)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Lit le manifeste d'une archive sans rien restaurer : permet à l'interface
/// d'afficher date/version/volume avant que l'utilisateur ne confirme.
#[tauri::command]
pub fn backup_inspect(path: String, passphrase: Option<String>) -> Result<Manifest, String> {
    let path = resolve_plain(&path, passphrase.as_deref())?;
    let file = fs::File::open(&path).map_err(|e| format!("Archive illisible : {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Archive invalide : {e}"))?;
    let mut entry = zip
        .by_name(MANIFEST_NAME)
        .map_err(|_| "Ce fichier n'est pas une sauvegarde Lumen.".to_string())?;
    let mut s = String::new();
    entry.read_to_string(&mut s).map_err(|e| e.to_string())?;
    let manifest: Manifest = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    if manifest.format > FORMAT_VERSION {
        return Err(format!(
            "Sauvegarde au format {} — cette version de Lumen lit jusqu'au format {}. Mets Lumen à jour.",
            manifest.format, FORMAT_VERSION
        ));
    }
    Ok(manifest)
}

/// Restaure une archive par-dessus l'état courant.
///
/// `wipe = true` remplace : tout ce qui est sauvegardable est effacé avant
/// d'extraire (les runtimes exclus, eux, sont laissés en place). `wipe = false`
/// fusionne : les fichiers de l'archive écrasent leurs homonymes, le reste est
/// conservé.
///
/// Dans les deux cas une archive de l'état PRÉCÉDENT est écrite d'abord ; son
/// chemin est renvoyé et doit être montré à l'utilisateur.
#[tauri::command]
pub fn backup_import(
    app: tauri::AppHandle,
    path: String,
    wipe: bool,
    passphrase: Option<String>,
) -> Result<RestoreSummary, String> {
    let path = resolve_plain(&path, passphrase.as_deref())?;
    let manifest = backup_inspect(path.clone(), None)?;
    let root = data_dir(&app)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    // Filet de sécurité : on ne détruit jamais l'état courant sans en avoir
    // gardé une copie.
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S");
    let rollback = root.join(format!("pre-restore_{stamp}.lumenbackup"));
    let rollback_path = match write_archive(&app, &root, &rollback) {
        Ok(s) => s.path,
        Err(e) => return Err(format!("Impossible de sauvegarder l'état actuel ({e}) — restauration annulée.")),
    };

    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    if wipe {
        let mut current = Vec::new();
        let mut skipped = Vec::new();
        walk(&root, &root, &mut current, &mut skipped);
        for (p, rel) in current {
            // Ne pas effacer l'archive de secours qu'on vient d'écrire.
            if rel.ends_with(".lumenbackup") {
                continue;
            }
            let _ = fs::remove_file(p);
        }
    }

    let mut files = 0usize;
    let mut bytes = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if !entry.is_file() {
            continue;
        }
        let name = entry.name().to_string();
        let Some(rel) = name.strip_prefix("data/") else { continue };
        // Défense contre le zip-slip : aucun chemin remontant ni absolu.
        if rel.is_empty()
            || rel.starts_with('/')
            || rel.split('/').any(|s| s == ".." || s == ".")
            || Path::new(rel).is_absolute()
        {
            continue;
        }
        let dest = root.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        fs::write(&dest, &buf).map_err(|e| format!("Écriture de {rel} : {e}"))?;
        files += 1;
        bytes += buf.len() as u64;
    }

    Ok(RestoreSummary {
        files,
        bytes,
        created_at: manifest.created_at,
        app_version: manifest.app_version,
        rollback_path,
    })
}

/// Ouvre le dossier contenant un fichier dans l'explorateur du système.
#[tauri::command]
pub fn backup_reveal(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = PathBuf::from(&path);
    let target = p.parent().map(|d| d.to_path_buf()).unwrap_or(p);
    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::is_excluded;

    #[test]
    fn exclut_les_runtimes_et_leur_descendance() {
        assert!(is_excluded("models"));
        assert!(is_excluded("models/lfm2.gguf"));
        assert!(is_excluded("piper-voices/fr/upmc.onnx"));
        assert!(is_excluded("window-diagnostics.log"));
    }

    #[test]
    fn garde_les_donnees_utilisateur() {
        assert!(!is_excluded("tables.db"));
        assert!(!is_excluded("sandboxes/notes/index.html"));
        assert!(!is_excluded("memory.json"));
        // Un fichier nommé comme un dossier exclu mais ailleurs reste inclus.
        assert!(!is_excluded("sandboxes/models"));
    }
}
