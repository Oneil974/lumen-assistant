//! Sandboxes fichiers pour l'agent. Chaque sandbox est un dossier isolé sous
//! `app_data_dir/sandboxes/<id>/root/` pour le profil historique, ou sous
//! `app_data_dir/profiles/<profile_id>/sandboxes/<id>/root/` pour les autres.
//! **Toutes** les opérations fichiers sont
//! confinées à cette racine :
//!   1. on n'accepte que des composants de chemin « normaux » (pas de `..`, pas
//!      de chemin absolu) ;
//!   2. on canonicalise l'ancêtre existant le plus proche et on vérifie qu'il
//!      reste sous la racine canonique (défense contre les symlinks d'évasion).
//! Un **quota de taille** (octets) par sandbox empêche de remplir le disque hôte.
//!
//! Note : c'est une sandbox *applicative* (pas une isolation noyau). Elle protège
//! contre un agent qui dérape ou un fichier piégé, à condition de NE PAS exposer
//! d'exécution de commandes ni de réseau arbitraire au périmètre agent.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{Emitter, Manager};

/// Métadonnées d'une sandbox, persistées dans `sandboxes/registry.json`.
#[derive(Serialize, Deserialize, Clone)]
pub struct SandboxMeta {
    pub id: String,
    pub name: String,
    pub max_bytes: u64,
    pub created: u64,
}

/// Entrée renvoyée à l'UI lors du listing d'un dossier.
#[derive(Serialize)]
pub struct FsEntry {
    pub name: String,
    /// Chemin relatif à la racine de la sandbox (séparateur `/`).
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    /// Date de création (epoch secondes). Tous les systèmes de fichiers ne la
    /// tiennent pas (ext4 ancien, certains montages réseau) : on retombe alors
    /// sur la date de modification plutôt que d'afficher « 1970 ».
    pub created: u64,
}

/// Contenu d'un fichier renvoyé à l'UI.
#[derive(Serialize)]
pub struct FileContent {
    pub content: String,
    pub binary: bool,
    pub truncated: bool,
    pub size: u64,
}

/// Occupation d'une sandbox.
#[derive(Serialize)]
pub struct Usage {
    pub used_bytes: u64,
    pub max_bytes: u64,
}

const MAX_READ_BYTES: u64 = 512 * 1024; // aperçu texte générique plafonné à 512 Ko
                                        // Fichiers code/texte ouverts dans l'éditeur : plafond bien plus haut pour ne pas
                                        // tronquer des fichiers volumineux (sinon perte de données à l'enregistrement).
const MAX_CODE_READ_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CREATIVE_READ_BYTES: u64 = 16 * 1024 * 1024; // documents design avec images legacy

// Extensions traitées comme du code/texte éditable (limite de lecture relevée).
const CODE_EXTS: &[&str] = &[
    "html",
    "htm",
    "xhtml",
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "tsx",
    "css",
    "scss",
    "sass",
    "less",
    "json",
    "jsonc",
    "json5",
    "xml",
    "svg",
    "yml",
    "yaml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "md",
    "markdown",
    "txt",
    "text",
    "log",
    "csv",
    "tsv",
    "py",
    "rb",
    "php",
    "go",
    "rs",
    "c",
    "h",
    "cpp",
    "hpp",
    "cc",
    "cxx",
    "java",
    "kt",
    "swift",
    "sh",
    "bash",
    "zsh",
    "fish",
    "sql",
    "lua",
    "vue",
    "svelte",
    "astro",
    "graphql",
    "gql",
    "dockerfile",
    "makefile",
    "gradle",
    "properties",
];

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Dossier racine de toutes les sandboxes (`app_data_dir/sandboxes`), créé si besoin.
pub(crate) fn sandboxes_base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    let profile_id = crate::session::active_profile_id(app);
    let base = if crate::session::active_profile_uses_legacy_workspace(app) {
        app_dir.join("sandboxes")
    } else {
        app_dir.join("profiles").join(profile_id).join("sandboxes")
    };
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

fn registry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(sandboxes_base(app)?.join("registry.json"))
}

fn read_registry(app: &tauri::AppHandle) -> Result<Vec<SandboxMeta>, String> {
    let p = registry_path(app)?;
    match fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(_) => Ok(vec![]),
    }
}

fn write_registry(app: &tauri::AppHandle, list: &[SandboxMeta]) -> Result<(), String> {
    let p = registry_path(app)?;
    let s = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(&p, s).map_err(|e| e.to_string())
}

/// Slug filesystem-safe dérivé d'un nom + horodatage, pour un id unique et sûr.
fn make_id(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "sandbox" } else { slug };
    format!("{slug}-{}", now_secs())
}

/// Chemin de la racine d'une sandbox (exposé pour confiner le moteur Fluxo aux
/// fichiers de la sandbox d'un agent — cf. `agents::tick_agent`).
pub fn root_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    sandbox_root(app, id)
}

/// Résout l'id d'une sandbox depuis son **nom** (ou son id). Utilisé par le pont
/// companion pour les blocs Fluxo « Lire/Écrire un fichier » avec sandbox nommée.
pub fn id_for_name(app: &tauri::AppHandle, name: &str) -> Option<String> {
    read_registry(app)
        .ok()?
        .into_iter()
        .find(|m| m.name == name || m.id == name)
        .map(|m| m.id)
}

/// Valide qu'un id est un slug simple (aucun séparateur de chemin) et renvoie la
/// racine `sandboxes/<id>/root`.
pub(crate) fn sandbox_root(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.contains(':')
    {
        return Err("Identifiant de sandbox invalide".into());
    }
    Ok(sandboxes_base(app)?.join(id).join("root"))
}

/// Chemin absolu d'un fichier de sandbox, confiné (pour les modules qui doivent
/// passer un fichier à un outil externe : déploiement SSH de l'Atelier ML).
pub(crate) fn sandbox_file_path(app: &tauri::AppHandle, id: &str, rel: &str) -> Result<PathBuf, String> {
    let root = sandbox_root(app, id)?;
    resolve(&root, rel)
}

/// Résout un chemin relatif **confiné** à `root`. Rejette tout composant non
/// « normal » (absolu, `..`, préfixe) puis vérifie qu'aucun symlink ne fait sortir.
fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut out = root.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            // Absolu, `..`, ou préfixe Windows : refusés.
            _ => return Err("Chemin hors sandbox".into()),
        }
    }
    // Défense anti-symlink : l'ancêtre existant le plus proche doit canoniquement
    // rester sous la racine canonique.
    let root_canon = root.canonicalize().map_err(|e| e.to_string())?;
    let mut anc: &Path = &out;
    let existing = loop {
        if anc.exists() {
            break anc.canonicalize().map_err(|e| e.to_string())?;
        }
        match anc.parent() {
            Some(p) => anc = p,
            None => return Err("Chemin hors sandbox".into()),
        }
    };
    if !existing.starts_with(&root_canon) {
        return Err("Chemin hors sandbox".into());
    }
    Ok(out)
}

/// Taille totale (récursive) des fichiers sous `dir`.
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if let Ok(md) = e.metadata() {
                if md.is_dir() {
                    total += dir_size(&p);
                } else {
                    total += md.len();
                }
            }
        }
    }
    total
}

fn meta_of(app: &tauri::AppHandle, id: &str) -> Result<SandboxMeta, String> {
    read_registry(app)?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| "Sandbox introuvable".into())
}

// ===================== Commandes Tauri =====================

fn require_session(
    app: &tauri::AppHandle,
    session: &tauri::State<'_, crate::session::SessionState>,
) -> Result<(), String> {
    crate::session::require_unlocked(app, session.inner())
}

#[tauri::command]
pub fn sandbox_list(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
) -> Result<Vec<SandboxMeta>, String> {
    require_session(&app, &session)?;
    ensure_default_sandbox(&app);
    sandbox_list_unchecked(&app)
}

/// Premier usage : une sandbox « Documents » existe d'office, pour que les
/// apps (Notes, Éditeur, Photos…) fonctionnent sans passage préalable par la
/// Bibliothèque. Une seule fois (marqueur) : si l'utilisateur supprime ensuite
/// toutes ses sandboxes, on ne la recrée pas dans son dos.
fn ensure_default_sandbox(app: &tauri::AppHandle) {
    let Ok(base) = sandboxes_base(app) else { return };
    let marker = base.join(".default-created");
    if marker.exists() {
        return;
    }
    if read_registry(app).map(|l| l.is_empty()).unwrap_or(false) {
        if sandbox_create_unchecked(app.clone(), "Documents".into(), 2048).is_err() {
            return;
        }
    }
    let _ = fs::create_dir_all(&base);
    let _ = fs::write(&marker, b"");
}

/// Noms des sandboxes, lisibles même bureau verrouillé : de quoi CHOISIR la
/// sandbox d'un agent (le choix lui-même exige le mot de passe de session, cf.
/// `agents::agent_save`). Ni quota, ni date, ni contenu.
#[tauri::command]
pub fn sandbox_list_names(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    Ok(read_registry(&app)?
        .into_iter()
        .map(|m| serde_json::json!({ "id": m.id, "name": m.name }))
        .collect())
}

pub fn sandbox_list_unchecked(app: &tauri::AppHandle) -> Result<Vec<SandboxMeta>, String> {
    read_registry(&app)
}

#[tauri::command]
pub fn sandbox_create(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    name: String,
    max_mb: u64,
) -> Result<SandboxMeta, String> {
    require_session(&app, &session)?;
    sandbox_create_unchecked(app, name, max_mb)
}

pub fn sandbox_create_unchecked(
    app: tauri::AppHandle,
    name: String,
    max_mb: u64,
) -> Result<SandboxMeta, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Nom requis".into());
    }
    let id = make_id(name);
    let root = sandbox_root(&app, &id)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let meta = SandboxMeta {
        id,
        name: name.to_string(),
        max_bytes: max_mb.max(1) * 1024 * 1024,
        created: now_secs(),
    };
    let mut list = read_registry(&app)?;
    list.push(meta.clone());
    write_registry(&app, &list)?;
    let _ = app.emit("lumen-sandboxes-changed", ());
    Ok(meta)
}

/// Modifie le quota de taille (en Mo) d'une sandbox existante. Refuse une valeur
/// inférieure à l'occupation actuelle pour ne pas créer un quota déjà dépassé.
#[tauri::command]
pub fn sandbox_set_size(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    max_mb: u64,
) -> Result<SandboxMeta, String> {
    require_session(&app, &session)?;
    let root = sandbox_root(&app, &id)?;
    let used = dir_size(&root);
    let new_max = max_mb.max(1) * 1024 * 1024;
    if new_max < used {
        return Err(format!(
            "La nouvelle limite ({} Mo) est inférieure à l'occupation actuelle ({} Mo).",
            max_mb,
            (used + 1024 * 1024 - 1) / (1024 * 1024)
        ));
    }
    let mut list = read_registry(&app)?;
    let meta = list
        .iter_mut()
        .find(|m| m.id == id)
        .ok_or_else(|| "Sandbox introuvable".to_string())?;
    meta.max_bytes = new_max;
    let updated = meta.clone();
    write_registry(&app, &list)?;
    Ok(updated)
}

/// Importe (upload) un fichier dans la sandbox depuis l'hôte. Le contenu est
/// transmis encodé en base64 (l'UI lit le fichier choisi côté webview). Quota vérifié.
#[tauri::command]
pub fn sandbox_import_file(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
    data_b64: String,
) -> Result<(), String> {
    require_session(&app, &session)?;
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| e.to_string())?;
    sandbox_write_binary(app, id, path, bytes)
}

pub fn sandbox_write_binary(
    app: tauri::AppHandle,
    id: String,
    path: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let meta = meta_of(&app, &id)?;
    let root = sandbox_root(&app, &id)?;
    let file = resolve(&root, &path)?;
    let old = fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    let used = dir_size(&root);
    let new_total = used.saturating_sub(old) + bytes.len() as u64;
    if new_total > meta.max_bytes {
        return Err(format!(
            "Quota dépassé : {} octets pour une limite de {} octets",
            new_total, meta.max_bytes
        ));
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file, bytes).map_err(|e| e.to_string())
}

/// Exporte (download) un fichier de la sandbox vers le dossier Téléchargements de
/// l'hôte. Renvoie le chemin hôte écrit (suffixé si un fichier de même nom existe).
#[tauri::command]
pub fn sandbox_export_file(
    app: tauri::AppHandle,
    id: String,
    path: String,
) -> Result<String, String> {
    let root = sandbox_root(&app, &id)?;
    let src = resolve(&root, &path)?;
    let bytes = fs::read(&src).map_err(|e| e.to_string())?;
    let dl = app.path().download_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dl).map_err(|e| e.to_string())?;
    let name = Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "fichier".into());
    // Évite d'écraser : suffixe -1, -2, … si nécessaire.
    let mut dest = dl.join(&name);
    if dest.exists() {
        let stem = Path::new(&name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        let ext = Path::new(&name)
            .extension()
            .map(|s| format!(".{}", s.to_string_lossy()))
            .unwrap_or_default();
        for i in 1.. {
            let cand = dl.join(format!("{stem}-{i}{ext}"));
            if !cand.exists() {
                dest = cand;
                break;
            }
            if i > 9999 {
                break;
            }
        }
    }
    fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn sandbox_delete(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
) -> Result<(), String> {
    require_session(&app, &session)?;
    // Supprime tout le dossier de la sandbox (root + métadonnées éventuelles).
    let dir = sandboxes_base(&app)?.join(&id);
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return Err("Identifiant invalide".into());
    }
    let _ = fs::remove_dir_all(&dir);
    let list: Vec<SandboxMeta> = read_registry(&app)?
        .into_iter()
        .filter(|m| m.id != id)
        .collect();
    write_registry(&app, &list)?;
    let _ = app.emit("lumen-sandboxes-changed", ());
    Ok(())
}

#[tauri::command]
pub fn sandbox_usage(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
) -> Result<Usage, String> {
    require_session(&app, &session)?;
    let meta = meta_of(&app, &id)?;
    let root = sandbox_root(&app, &id)?;
    Ok(Usage {
        used_bytes: dir_size(&root),
        max_bytes: meta.max_bytes,
    })
}

#[tauri::command]
pub fn sandbox_read_dir(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    require_session(&app, &session)?;
    sandbox_read_dir_unchecked(&app, &id, &path)
}

/// Même listage, sans contrôle de session : appelé par la boucle agentique, qui
/// tourne hors d'une fenêtre et n'a pas de session utilisateur. Le confinement à
/// la racine de la sandbox reste assuré par `resolve`.
pub fn sandbox_read_dir_unchecked(
    app: &tauri::AppHandle,
    id: &str,
    path: &str,
) -> Result<Vec<FsEntry>, String> {
    let root = sandbox_root(app, id)?;
    let dir = resolve(&root, &path)?;
    let mut out = vec![];
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let md = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = e.file_name().to_string_lossy().to_string();
        let rel = if path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", path.trim_end_matches('/'), name)
        };
        let secs = |t: std::io::Result<std::time::SystemTime>| {
            t.ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0)
        };
        let modified = secs(md.modified());
        let created = match secs(md.created()) {
            0 => modified,
            c => c,
        };
        out.push(FsEntry {
            name,
            path: rel,
            is_dir: md.is_dir(),
            size: if md.is_dir() { 0 } else { md.len() },
            modified,
            created,
        });
    }
    // Dossiers d'abord, puis tri alphabétique.
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub fn sandbox_read_file(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
) -> Result<FileContent, String> {
    require_session(&app, &session)?;
    sandbox_read_file_unchecked(app, id, path)
}

pub fn sandbox_read_file_unchecked(
    app: tauri::AppHandle,
    id: String,
    path: String,
) -> Result<FileContent, String> {
    let root = sandbox_root(&app, &id)?;
    let file = resolve(&root, &path)?;
    let md = fs::metadata(&file).map_err(|e| e.to_string())?;
    let size = md.len();
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let max_read = if matches!(ext.as_str(), "lumenpages" | "lumenkey") {
        MAX_CREATIVE_READ_BYTES
    } else if CODE_EXTS.contains(&ext.as_str()) {
        MAX_CODE_READ_BYTES
    } else {
        MAX_READ_BYTES
    };
    let slice = if bytes.len() as u64 > max_read {
        &bytes[..max_read as usize]
    } else {
        &bytes[..]
    };
    let truncated = bytes.len() as u64 > max_read;
    // Binaire si NUL présent ou UTF-8 invalide.
    match std::str::from_utf8(slice) {
        Ok(s) if !s.contains('\0') => Ok(FileContent {
            content: s.to_string(),
            binary: false,
            truncated,
            size,
        }),
        _ => Ok(FileContent {
            content: String::new(),
            binary: true,
            truncated: false,
            size,
        }),
    }
}

// ===== Snapshots / historique de versions =====
// Stockés HORS de `root/` (donc hors quota et invisibles dans l'explorateur),
// sous `sandboxes/<id>/snapshots/<base64url(chemin)>.json`. Une version est
// poussée automatiquement à chaque `sandbox_write_file` (avant écrasement).

#[derive(Serialize, Deserialize, Clone)]
struct Snapshot {
    ts: u64, // millisecondes epoch
    content: String,
}

/// Métadonnée d'une version renvoyée à l'UI (sans le contenu).
#[derive(Serialize)]
pub struct SnapshotInfo {
    pub ts: u64,
    pub size: u64,
}

const MAX_SNAPSHOTS: usize = 25;
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024; // on ne versionne pas au-delà

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn snapshots_dir(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let root = sandbox_root(app, id)?;
    let dir = root
        .parent()
        .ok_or("racine de sandbox invalide")?
        .join("snapshots");
    Ok(dir)
}

fn snap_path(dir: &Path, rel: &str) -> PathBuf {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    dir.join(format!("{}.json", URL_SAFE_NO_PAD.encode(rel.as_bytes())))
}

fn read_snaps(file: &Path) -> Vec<Snapshot> {
    fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Pousse une version (contenu *précédent*) pour un fichier. Ignore les doublons
/// consécutifs et les contenus trop volumineux. Best-effort (jamais bloquant).
fn push_snapshot(app: &tauri::AppHandle, id: &str, rel: &str, content: &str) {
    if content.len() > MAX_SNAPSHOT_BYTES {
        return;
    }
    let dir = match snapshots_dir(app, id) {
        Ok(d) => d,
        Err(_) => return,
    };
    let _ = fs::create_dir_all(&dir);
    let file = snap_path(&dir, rel);
    let mut snaps = read_snaps(&file);
    if snaps.last().map(|s| s.content == content).unwrap_or(false) {
        return; // identique à la dernière version : rien à faire
    }
    snaps.push(Snapshot {
        ts: now_millis(),
        content: content.to_string(),
    });
    let len = snaps.len();
    if len > MAX_SNAPSHOTS {
        snaps.drain(0..len - MAX_SNAPSHOTS);
    }
    if let Ok(json) = serde_json::to_vec(&snaps) {
        let _ = fs::write(&file, json);
    }
}

/// Liste les versions d'un fichier (la plus récente en dernier).
#[tauri::command]
pub fn sandbox_snapshot_list(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
) -> Result<Vec<SnapshotInfo>, String> {
    require_session(&app, &session)?;
    let dir = snapshots_dir(&app, &id)?;
    let file = snap_path(&dir, &path);
    Ok(read_snaps(&file)
        .iter()
        .map(|s| SnapshotInfo {
            ts: s.ts,
            size: s.content.len() as u64,
        })
        .collect())
}

/// Renvoie le contenu d'une version donnée (par `ts`).
#[tauri::command]
pub fn sandbox_snapshot_get(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
    ts: u64,
) -> Result<String, String> {
    require_session(&app, &session)?;
    let dir = snapshots_dir(&app, &id)?;
    let file = snap_path(&dir, &path);
    read_snaps(&file)
        .into_iter()
        .find(|s| s.ts == ts)
        .map(|s| s.content)
        .ok_or_else(|| "Version introuvable".into())
}

/// Lit une IMAGE de la sandbox, redimensionnée, en data-URL base64.
///
/// `sandbox_read_b64` plafonne à 8 Mo — une photo de téléphone dépasse ce seuil
/// et le fond d'écran échouait sans un mot. Ici on décode le fichier, on le
/// réduit à `max_px` sur son plus grand côté et on ré-encode en JPEG : un fond
/// d'écran n'a pas besoin de plus, et la valeur transmise reste légère.
#[tauri::command]
pub fn sandbox_read_image_b64(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
    max_px: Option<u32>,
) -> Result<String, String> {
    require_session(&app, &session)?;
    use base64::{engine::general_purpose::STANDARD, Engine};
    const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024; // garde-fou disque
    let root = sandbox_root(&app, &id)?;
    let file = resolve(&root, &path)?;
    let md = fs::metadata(&file).map_err(|e| e.to_string())?;
    if md.len() > MAX_SOURCE_BYTES {
        return Err(format!("Image trop volumineuse ({} octets)", md.len()));
    }
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("Image illisible : {e}"))?;
    let max_px = max_px.unwrap_or(2560).clamp(64, 6000);
    let (w, h) = (img.width(), img.height());
    let img = if w.max(h) > max_px {
        img.resize(max_px, max_px, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let mut out = std::io::Cursor::new(Vec::new());
    img.to_rgb8()
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .map_err(|e| format!("Encodage impossible : {e}"))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        STANDARD.encode(out.into_inner())
    ))
}

// ===================== Bibliothèque d'images =====================
//
// L'app Photos parcourt TOUTES les sandboxes : un listage plat des images
// (dimensions comprises, lues dans l'en-tête sans décoder) et des vignettes
// mises en cache sur disque (`photo-thumbs/<sandbox>/<hash>.jpg`, clé =
// chemin + taille + date), sinon ouvrir une bibliothèque de 500 images
// redécoderait 500 fichiers à chaque fois.

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "avif"];

#[derive(Serialize)]
pub struct ImageEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: u64,
    pub created: u64,
    pub width: u32,
    pub height: u32,
    /// Dossier parent (relatif), pour regrouper dans l'interface.
    pub folder: String,
}

fn is_image_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !lower.starts_with("._")
        && Path::new(&lower)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| IMAGE_EXTS.contains(&e))
}

fn walk_images(root: &Path, dir: &Path, rel: &str, out: &mut Vec<ImageEntry>, depth: usize) {
    if depth > 12 || out.len() >= 5000 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if md.is_dir() {
            walk_images(root, &e.path(), &child_rel, out, depth + 1);
            continue;
        }
        if !is_image_name(&name) {
            continue;
        }
        let secs = |t: std::io::Result<std::time::SystemTime>| {
            t.ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0)
        };
        let modified = secs(md.modified());
        let created = match secs(md.created()) { 0 => modified, c => c };
        // Dimensions par l'en-tête seul : pas de décodage complet.
        let (width, height) = image::image_dimensions(e.path()).unwrap_or((0, 0));
        out.push(ImageEntry {
            name,
            path: child_rel,
            size: md.len(),
            modified,
            created,
            width,
            height,
            folder: rel.to_string(),
        });
    }
}

/// Toutes les images d'une sandbox (récursif), les plus récentes d'abord.
#[tauri::command]
pub fn sandbox_list_images(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
) -> Result<Vec<ImageEntry>, String> {
    require_session(&app, &session)?;
    let root = sandbox_root(&app, &id)?;
    let mut out = Vec::new();
    walk_images(&root, &root, "", &mut out, 0);
    out.sort_by(|a, b| b.created.cmp(&a.created).then(a.path.cmp(&b.path)));
    Ok(out)
}

fn thumbs_dir(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path())
        .map_err(|e| e.to_string())?
        .join("photo-thumbs")
        .join(id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Vignette JPEG (data URL) d'une image, `max_px` sur le plus grand côté,
/// servie depuis le cache disque quand le fichier n'a pas changé.
#[tauri::command]
pub fn sandbox_image_thumb(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
    max_px: Option<u32>,
) -> Result<String, String> {
    require_session(&app, &session)?;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::hash::{Hash, Hasher};
    let root = sandbox_root(&app, &id)?;
    let file = resolve(&root, &path)?;
    let md = fs::metadata(&file).map_err(|e| e.to_string())?;
    let max_px = max_px.unwrap_or(360).clamp(48, 1024);
    let modified = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (&path, md.len(), modified, max_px).hash(&mut hasher);
    let cache = thumbs_dir(&app, &id)?.join(format!("{:016x}.jpg", hasher.finish()));
    if let Ok(bytes) = fs::read(&cache) {
        return Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)));
    }
    if md.len() > 64 * 1024 * 1024 {
        return Err("Image trop volumineuse".into());
    }
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("Image illisible : {e}"))?;
    let img = if img.width().max(img.height()) > max_px {
        img.thumbnail(max_px, max_px)
    } else {
        img
    };
    let mut out = std::io::Cursor::new(Vec::new());
    // Fond blanc sous les PNG transparents : un JPEG n'a pas d'alpha.
    let rgba = img.to_rgba8();
    let mut rgb = image::RgbImage::from_pixel(rgba.width(), rgba.height(), image::Rgb([255, 255, 255]));
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let mix = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        rgb.put_pixel(x, y, image::Rgb([mix(p[0]), mix(p[1]), mix(p[2])]));
    }
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82)
        .encode_image(&rgb)
        .map_err(|e| format!("Encodage impossible : {e}"))?;
    let data = out.into_inner();
    let _ = fs::write(&cache, &data);
    Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(data)))
}

/// Lit un fichier de la sandbox en base64 (assets binaires d'une mini-app :
/// images, polices…). Plafonné pour éviter d'embarquer des fichiers énormes.
#[tauri::command]
pub fn sandbox_read_b64(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
) -> Result<String, String> {
    require_session(&app, &session)?;
    use base64::{engine::general_purpose::STANDARD, Engine};
    const MAX_ASSET_BYTES: u64 = 8 * 1024 * 1024; // 8 Mo par asset
    let root = sandbox_root(&app, &id)?;
    let file = resolve(&root, &path)?;
    let md = fs::metadata(&file).map_err(|e| e.to_string())?;
    if md.len() > MAX_ASSET_BYTES {
        return Err(format!(
            "Asset trop volumineux ({} octets, max {})",
            md.len(),
            MAX_ASSET_BYTES
        ));
    }
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub fn sandbox_write_file(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    require_session(&app, &session)?;
    sandbox_write_file_unchecked(app, id, path, content)
}

/// Octets bruts d'un fichier de la sandbox, sans contrôle de session : sert à
/// la boucle agentique (extraction de texte d'un PDF, par exemple). Le
/// confinement à la racine reste assuré par `resolve`.
/// Le chemin existe-t-il dans la sandbox ? Sert à vérifier qu'un livrable
/// ANNONCÉ par un agent a bien été écrit : un modèle qui déclare « résumé
/// sauvegardé » sans avoir appelé l'outil d'écriture ne doit pas pouvoir
/// clore sa tâche.
pub fn exists_unchecked(app: &tauri::AppHandle, id: &str, path: &str) -> bool {
    sandbox_root(app, id)
        .ok()
        .and_then(|root| resolve(&root, path).ok())
        .map(|p| p.exists())
        .unwrap_or(false)
}

pub fn sandbox_read_bytes_unchecked(
    app: &tauri::AppHandle,
    id: &str,
    path: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let root = sandbox_root(app, id)?;
    let file = resolve(&root, path)?;
    let md = fs::metadata(&file).map_err(|e| e.to_string())?;
    if md.len() > max_bytes {
        return Err(format!(
            "Fichier trop volumineux ({} octets, maximum {max_bytes}).",
            md.len()
        ));
    }
    fs::read(&file).map_err(|e| e.to_string())
}

pub fn sandbox_write_file_unchecked(
    app: tauri::AppHandle,
    id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let meta = meta_of(&app, &id)?;
    let root = sandbox_root(&app, &id)?;
    let file = resolve(&root, &path)?;
    // Contrôle de quota : taille actuelle - ancienne taille du fichier + nouvelle.
    let old = fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    let used = dir_size(&root);
    let new_total = used.saturating_sub(old) + content.len() as u64;
    if new_total > meta.max_bytes {
        return Err(format!(
            "Quota dépassé : {} octets demandés pour une limite de {} octets",
            new_total, meta.max_bytes
        ));
    }
    // Historique : on versionne le contenu *précédent* (texte) avant d'écraser.
    if let Ok(prev) = fs::read(&file) {
        if let Ok(prev_str) = String::from_utf8(prev) {
            if prev_str != content {
                push_snapshot(&app, &id, &path, &prev_str);
            }
        }
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file, content).map_err(|e| e.to_string())
}

/// Liste des extensions exportables en PDF (pour griser/afficher l'action côté UI).
#[tauri::command]
pub fn sandbox_pdf_formats() -> Vec<String> {
    [
        "md", "markdown", "txt", "log", "csv", "tsv", "json", "html", "htm",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Génère un PDF à partir d'un fichier texte de la sandbox (Markdown & formats
/// faciles à transformer). Le PDF est écrit **dans la même sandbox** (confiné,
/// quota respecté), à côté de la source, avec l'extension `.pdf`. Renvoie le
/// chemin relatif du PDF créé.
/// Écrit un PDF **rendu depuis du markdown** dans une sandbox (racine de la
/// sandbox), sans passer par un fichier source. C'est le chemin de l'export
/// d'une discussion depuis le bureau : les Téléchargements sont hors de
/// l'espace confiné, alors qu'en mode bureau tout le travail vit dans la
/// sandbox — le PDF y a sa place, à côté du reste.
///
/// Mêmes garanties que les autres écritures de sandbox : session ouverte,
/// chemin confiné, quota vérifié avant écriture, et jamais d'écrasement (un
/// second export du même titre produit « Titre (2).pdf »).
#[tauri::command]
pub fn sandbox_write_pdf(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    title: String,
    content: String,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    require_session(&app, &session)?;
    if content.trim().is_empty() {
        return Err("Contenu vide : rien à mettre dans le PDF.".into());
    }
    let meta = meta_of(&app, &id)?;
    let root = sandbox_root(&app, &id)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let stem = crate::pdf::safe_stem(&title);
    let pdf = crate::pdf::render_to_pdf(&stem, "md", &content)?;

    // `path` (relatif à la sandbox) place le PDF où l'appelant le veut — un
    // rapport se range à côté de son HTML, pas à la racine ; sans lui, on
    // garde l'ancien comportement (nom libre à la racine).
    let dest = match path.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(p) => {
            let d = resolve(&root, p)?;
            if let Some(parent) = d.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            d
        }
        None => crate::pdf::free_path(&root, &stem),
    };
    let used = dir_size(&root);
    let new_total = used + pdf.len() as u64;
    if new_total > meta.max_bytes {
        return Err(format!(
            "Quota dépassé : {} octets demandés pour une limite de {} octets",
            new_total, meta.max_bytes
        ));
    }
    fs::write(&dest, &pdf).map_err(|e| e.to_string())?;

    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let rel = dest
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| name.clone());
    Ok(serde_json::json!({
        "path": rel,             // relatif à la racine de la sandbox
        "name": name,
        "bytes": pdf.len(),
    }))
}

#[tauri::command]
pub fn sandbox_export_pdf(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
) -> Result<String, String> {
    require_session(&app, &session)?;
    let meta = meta_of(&app, &id)?;
    let root = sandbox_root(&app, &id)?;
    let src = resolve(&root, &path)?;

    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !crate::pdf::is_supported(&ext) {
        return Err(format!("Format « .{ext} » non convertible en PDF"));
    }

    // Source : doit être du texte (UTF-8).
    let bytes = fs::read(&src).map_err(|e| e.to_string())?;
    let content =
        String::from_utf8(bytes).map_err(|_| "Le fichier n'est pas du texte".to_string())?;

    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();
    let pdf = crate::pdf::render_to_pdf(&stem, &ext, &content)?;

    // Chemin cible : <même dossier>/<nom>.pdf (chemin relatif à la sandbox).
    let rel_pdf = {
        let parent = Path::new(&path).parent();
        let name = format!("{stem}.pdf");
        match parent {
            Some(p) if !p.as_os_str().is_empty() => format!("{}/{}", p.to_string_lossy(), name),
            _ => name,
        }
    };
    let dest = resolve(&root, &rel_pdf)?;

    // Contrôle de quota : place actuelle - ancien PDF homonyme + nouveau.
    let old = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let used = dir_size(&root);
    let new_total = used.saturating_sub(old) + pdf.len() as u64;
    if new_total > meta.max_bytes {
        return Err(format!(
            "Quota dépassé : {} octets demandés pour une limite de {} octets",
            new_total, meta.max_bytes
        ));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&dest, pdf).map_err(|e| e.to_string())?;
    Ok(rel_pdf)
}

#[tauri::command]
pub fn sandbox_export_creative_pdf(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
    title: String,
    doc: Option<String>,
) -> Result<String, String> {
    require_session(&app, &session)?;
    let meta = meta_of(&app, &id)?;
    let root = sandbox_root(&app, &id)?;
    let src = resolve(&root, &path)?;
    // Si le modèle objet est fourni, on produit un PDF fidèle au canevas
    // (positions absolues, polices, couleurs, images) ; sinon repli sur le
    // rendu HTML/flux historique.
    let pdf = if let Some(json) = doc.as_deref().filter(|s| !s.is_empty()) {
        crate::pdf::render_creative_doc_to_pdf(&title, json, |asset| {
            let p = resolve(&root, asset)?;
            fs::read(&p).map_err(|e| e.to_string())
        })?
    } else {
        let content = fs::read_to_string(&src).map_err(|e| e.to_string())?;
        crate::pdf::render_creative_html_to_pdf(&title, &content, |asset| {
            let p = resolve(&root, asset)?;
            fs::read(&p).map_err(|e| e.to_string())
        })?
    };
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();
    let rel_pdf = {
        let parent = Path::new(&path).parent();
        let name = format!("{stem}.pdf");
        match parent {
            Some(p) if !p.as_os_str().is_empty() => format!("{}/{}", p.to_string_lossy(), name),
            _ => name,
        }
    };
    let dest = resolve(&root, &rel_pdf)?;
    let old = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let used = dir_size(&root);
    let new_total = used.saturating_sub(old) + pdf.len() as u64;
    if new_total > meta.max_bytes {
        return Err(format!(
            "Quota dépassé : {} octets demandés pour une limite de {} octets",
            new_total, meta.max_bytes
        ));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&dest, pdf).map_err(|e| e.to_string())?;
    Ok(rel_pdf)
}

#[tauri::command]
pub fn sandbox_create_dir(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
) -> Result<(), String> {
    require_session(&app, &session)?;
    let root = sandbox_root(&app, &id)?;
    let dir = resolve(&root, &path)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sandbox_create_file(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
) -> Result<(), String> {
    require_session(&app, &session)?;
    let root = sandbox_root(&app, &id)?;
    let file = resolve(&root, &path)?;
    if file.exists() {
        return Err("Existe déjà".into());
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file, b"").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sandbox_rename(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
    new_name: String,
) -> Result<(), String> {
    require_session(&app, &session)?;
    if new_name.contains('/') || new_name.contains('\\') || new_name.contains("..") {
        return Err("Nom invalide".into());
    }
    let root = sandbox_root(&app, &id)?;
    let src = resolve(&root, &path)?;
    let parent_rel = Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let dst_rel = if parent_rel.is_empty() {
        new_name.clone()
    } else {
        format!("{}/{}", parent_rel, new_name)
    };
    let dst = resolve(&root, &dst_rel)?;
    if dst.exists() {
        return Err("La cible existe déjà".into());
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sandbox_move_path(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
    dest_dir: String,
) -> Result<(), String> {
    require_session(&app, &session)?;
    if path.is_empty() {
        return Err("Chemin vide".into());
    }
    let root = sandbox_root(&app, &id)?;
    let src = resolve(&root, &path)?;
    let dst_dir = resolve(&root, &dest_dir)?;
    let md = fs::metadata(&src).map_err(|e| e.to_string())?;
    if !fs::metadata(&dst_dir).map_err(|e| e.to_string())?.is_dir() {
        return Err("Destination invalide".into());
    }
    let name = Path::new(&path)
        .file_name()
        .ok_or_else(|| "Nom invalide".to_string())?;
    let dst = dst_dir.join(name);
    if dst.exists() {
        return Err("La cible existe déjà".into());
    }
    if md.is_dir() && dst.starts_with(&src) {
        return Err("Déplacement invalide".into());
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())
}

/// Taille d'un chemin, fichier ou dossier. Sert à vérifier le quota AVANT de
/// commencer une copie : refuser à mi-parcours laisserait une arborescence
/// à moitié écrite dans la sandbox de destination.
fn path_size(p: &Path) -> u64 {
    match fs::metadata(p) {
        Ok(md) if md.is_dir() => dir_size(p),
        Ok(md) => md.len(),
        Err(_) => 0,
    }
}

/// Copie récursive. `fs::copy` ne sait copier qu'un fichier ; les dossiers se
/// font à la main, et il n'y a pas d'équivalent portable dans la bibliothèque
/// standard.
fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    let md = fs::metadata(src).map_err(|e| e.to_string())?;
    if md.is_file() {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(src, dst).map_err(|e| e.to_string())?;
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        copy_tree(&entry.path(), &dst.join(entry.file_name()))?;
    }
    Ok(())
}

/// Nom libre dans `dir` : `rapport.md` → `rapport (2).md` → `rapport (3).md`.
///
/// Coller deux fois dans le même dossier est un geste ordinaire ; échouer sur
/// « la cible existe déjà » obligerait à renommer à la main avant chaque
/// collage. On ne remplace jamais en silence — un doublon visible vaut mieux
/// qu'un fichier écrasé.
fn free_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        // Un nom qui COMMENCE par un point (.gitignore) n'a pas d'extension.
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for n in 2..1000 {
        let candidate = format!("{stem} ({n}){ext}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    // 998 doublons du même nom : on tranche avec l'horodatage plutôt que de
    // boucler indéfiniment.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{stem}-{stamp}{ext}")
}

/// Copie un fichier ou un dossier vers une AUTRE sandbox (ou la même).
///
/// `sandbox_move_path` ne savait déplacer qu'à l'intérieur d'une sandbox : le
/// cloisonnement était total, y compris pour l'utilisateur, qui devait
/// exporter puis réimporter pour faire passer un document d'un espace à
/// l'autre. Ici le cloisonnement reste entier — chaque chemin est résolu dans
/// SA racine, et le quota de la destination est vérifié avant d'écrire.
#[tauri::command(async)]
pub fn sandbox_copy_path(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
    dest_id: String,
    dest_dir: String,
) -> Result<String, String> {
    require_session(&app, &session)?;
    if path.is_empty() {
        return Err("Chemin vide".into());
    }
    let src_root = sandbox_root(&app, &id)?;
    let src = resolve(&src_root, &path)?;
    if !src.exists() {
        return Err("Source introuvable".into());
    }
    let dst_root = sandbox_root(&app, &dest_id)?;
    let dst_dir = resolve(&dst_root, &dest_dir)?;
    fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;
    if !fs::metadata(&dst_dir).map_err(|e| e.to_string())?.is_dir() {
        return Err("Destination invalide".into());
    }
    // Copier un dossier DANS lui-même ou dans l'un de ses descendants
    // bouclerait à l'infini. Le test ne vaut que dans la même sandbox.
    if id == dest_id && fs::metadata(&src).map(|m| m.is_dir()).unwrap_or(false) && dst_dir.starts_with(&src) {
        return Err("On ne peut pas copier un dossier dans lui-même.".into());
    }

    let size = path_size(&src);
    let meta = meta_of(&app, &dest_id)?;
    let used = dir_size(&dst_root);
    if used + size > meta.max_bytes {
        return Err(format!(
            "Quota de la sandbox de destination dépassé : {} octets nécessaires, {} disponibles.",
            size,
            meta.max_bytes.saturating_sub(used)
        ));
    }

    let name = Path::new(&path)
        .file_name()
        .ok_or_else(|| "Nom invalide".to_string())?
        .to_string_lossy()
        .to_string();
    let final_name = free_name(&dst_dir, &name);
    copy_tree(&src, &dst_dir.join(&final_name))?;
    Ok(final_name)
}

/// Déplace un fichier ou un dossier, y compris vers une AUTRE sandbox.
///
/// Dans la même sandbox c'est un `rename` (instantané). D'une sandbox à
/// l'autre, on copie PUIS on supprime : les deux racines sont sur le même
/// volume aujourd'hui, mais rien ne le garantit demain (une sandbox sur un
/// disque externe), et un `rename` inter-volumes échoue.
#[tauri::command(async)]
pub fn sandbox_transfer_path(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
    dest_id: String,
    dest_dir: String,
) -> Result<String, String> {
    require_session(&app, &session)?;
    if id == dest_id {
        let root = sandbox_root(&app, &id)?;
        let src = resolve(&root, &path)?;
        let dst_dir = resolve(&root, &dest_dir)?;
        fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;
        let name = Path::new(&path)
            .file_name()
            .ok_or_else(|| "Nom invalide".to_string())?
            .to_string_lossy()
            .to_string();
        if fs::metadata(&src).map(|m| m.is_dir()).unwrap_or(false) && dst_dir.starts_with(&src) {
            return Err("On ne peut pas déplacer un dossier dans lui-même.".into());
        }
        let final_name = free_name(&dst_dir, &name);
        fs::rename(&src, dst_dir.join(&final_name)).map_err(|e| e.to_string())?;
        return Ok(final_name);
    }
    let final_name = sandbox_copy_path(
        app.clone(),
        session,
        id.clone(),
        path.clone(),
        dest_id,
        dest_dir,
    )?;
    // La copie a réussi : on peut retirer l'original. Si la suppression
    // échouait, l'utilisateur se retrouverait avec un doublon — gênant, mais
    // jamais avec une perte.
    let root = sandbox_root(&app, &id)?;
    let src = resolve(&root, &path)?;
    if fs::metadata(&src).map(|m| m.is_dir()).unwrap_or(false) {
        fs::remove_dir_all(&src).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&src).map_err(|e| e.to_string())?;
    }
    Ok(final_name)
}

/// Déplace TOUT le contenu d'une sandbox vers une autre, à la racine ou dans
/// un sous-dossier. Sert à vider une sandbox avant de la supprimer, sans
/// perdre ce qu'elle contenait.
///
/// Renvoie le nombre d'entrées déplacées de premier niveau.
#[tauri::command(async)]
pub fn sandbox_move_all(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    dest_id: String,
    dest_dir: String,
) -> Result<usize, String> {
    require_session(&app, &session)?;
    if id == dest_id {
        return Err("La destination doit être une autre sandbox.".into());
    }
    let src_root = sandbox_root(&app, &id)?;
    let dst_root = sandbox_root(&app, &dest_id)?;
    let dst_dir = resolve(&dst_root, &dest_dir)?;
    fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;

    // Tout le contenu doit tenir : on vérifie une fois, globalement, plutôt
    // que de s'arrêter au milieu avec la moitié des fichiers déplacés.
    let meta = meta_of(&app, &dest_id)?;
    let used = dir_size(&dst_root);
    let needed = dir_size(&src_root);
    if used + needed > meta.max_bytes {
        return Err(format!(
            "La sandbox de destination ne peut pas tout accueillir : {} octets nécessaires, {} disponibles.",
            needed,
            meta.max_bytes.saturating_sub(used)
        ));
    }

    let mut moved = 0;
    for entry in fs::read_dir(&src_root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let final_name = free_name(&dst_dir, &name);
        copy_tree(&entry.path(), &dst_dir.join(&final_name))?;
        if entry.path().is_dir() {
            fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
        moved += 1;
    }
    Ok(moved)
}

#[tauri::command]
pub fn sandbox_delete_path(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
) -> Result<(), String> {
    require_session(&app, &session)?;
    if path.is_empty() {
        return Err("Chemin vide".into());
    }
    let root = sandbox_root(&app, &id)?;
    let target = resolve(&root, &path)?;
    let md = fs::metadata(&target).map_err(|e| e.to_string())?;
    if md.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&target).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod copy_tests {
    use super::*;

    /// Dossier de travail jetable. `tempfile` n'est pas une dépendance du
    /// projet et n'a pas à le devenir pour trois tests.
    fn scratch(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lumen-sandbox-test-{tag}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn free_name_suffixes_instead_of_overwriting() {
        let dir = scratch("free");
        assert_eq!(free_name(&dir, "rapport.md"), "rapport.md");
        fs::write(dir.join("rapport.md"), b"x").unwrap();
        assert_eq!(free_name(&dir, "rapport.md"), "rapport (2).md");
        fs::write(dir.join("rapport (2).md"), b"x").unwrap();
        assert_eq!(free_name(&dir, "rapport.md"), "rapport (3).md");
        // Un nom sans extension garde sa forme.
        fs::write(dir.join("notes"), b"x").unwrap();
        assert_eq!(free_name(&dir, "notes"), "notes (2)");
        // Un fichier caché n'a pas « gitignore » pour extension.
        fs::write(dir.join(".gitignore"), b"x").unwrap();
        assert_eq!(free_name(&dir, ".gitignore"), ".gitignore (2)");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn copy_tree_copies_files_and_folders() {
        let base = scratch("tree");
        let src = base.join("src");
        fs::create_dir_all(src.join("sous/dossier")).unwrap();
        fs::write(src.join("a.txt"), b"alpha").unwrap();
        fs::write(src.join("sous/b.txt"), b"beta").unwrap();
        fs::write(src.join("sous/dossier/c.txt"), b"gamma").unwrap();

        let dst = base.join("dst");
        copy_tree(&src, &dst).unwrap();
        assert_eq!(fs::read_to_string(dst.join("a.txt")).unwrap(), "alpha");
        assert_eq!(fs::read_to_string(dst.join("sous/b.txt")).unwrap(), "beta");
        assert_eq!(fs::read_to_string(dst.join("sous/dossier/c.txt")).unwrap(), "gamma");
        // L'original n'est pas touché : `copy_tree` copie, il ne déplace pas.
        assert!(src.join("a.txt").exists());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn copy_tree_of_a_single_file_creates_missing_parents() {
        let base = scratch("single");
        fs::write(base.join("note.md"), b"hello").unwrap();
        let dst = base.join("a/b/c/note.md");
        copy_tree(&base.join("note.md"), &dst).unwrap();
        assert_eq!(fs::read_to_string(&dst).unwrap(), "hello");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn path_size_counts_a_whole_tree() {
        let base = scratch("size");
        fs::create_dir_all(base.join("d")).unwrap();
        fs::write(base.join("d/x"), b"12345").unwrap();
        fs::write(base.join("d/y"), b"123").unwrap();
        assert_eq!(path_size(&base.join("d")), 8);
        assert_eq!(path_size(&base.join("d/x")), 5);
        // Un chemin absent vaut zéro : le quota ne doit pas exploser dessus.
        assert_eq!(path_size(&base.join("absent")), 0);
        fs::remove_dir_all(&base).ok();
    }
}

// ===== Lecture d'un document pour l'IA (chat) =====
//
// `sandbox_read_file` rend les octets bruts : un PDF y sortait « binaire », et
// l'IA du chat répondait sans avoir rien lu. Ici on passe par l'extracteur des
// agents (PDF, Word, Excel, PowerPoint, OpenDocument, HTML), et on tolère un
// chemin approximatif : les modèles réécrivent volontiers les noms
// (« CV_Andre_MARTIN 2026.pdf » → « CV_Andre_MARTIN_2026.pdf », accents
// recomposés, dossier oublié). Le chemin RÉEL est renvoyé pour la suite.

/// Clé de comparaison tolérante : minuscules, accents retirés (formes composée
/// et décomposée), et seuls les lettres/chiffres restent — espaces, `_`, `-`
/// et ponctuation ne comptent plus.
fn loose_key(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if ('\u{300}'..='\u{36f}').contains(&c) { continue; } // accent décomposé
        let base = match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => 'a',
            'ç' | 'Ç' => 'c',
            'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' | 'Ì' | 'Í' | 'Î' | 'Ï' => 'i',
            'ñ' | 'Ñ' => 'n',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => 'o',
            'ù' | 'ú' | 'û' | 'ü' | 'Ù' | 'Ú' | 'Û' | 'Ü' => 'u',
            'ÿ' | 'ý' | 'Ý' => 'y',
            'œ' | 'Œ' => { out.push_str("oe"); continue; }
            'æ' | 'Æ' => { out.push_str("ae"); continue; }
            _ => c,
        };
        for l in base.to_lowercase() {
            if l.is_alphanumeric() { out.push(l); }
        }
    }
    out
}

/// Retrouve un fichier d'après un chemin approximatif. Priorité : chemin
/// complet équivalent, puis même nom de fichier (n'importe quel dossier), puis
/// nom qui contient (ou est contenu dans) celui demandé. `None` si ambigu.
fn find_loose(root: &Path, wanted: &str) -> Option<String> {
    let want_rel = loose_key(wanted);
    let want_file = wanted.rsplit(['/', '\\']).next().unwrap_or(wanted);
    let want_name = loose_key(want_file);
    // Nom sans extension (comparaisons partielles) + extension, qui doit concorder.
    let (want_stem, want_ext) = match want_file.rsplit_once('.') {
        Some((a, b)) => (loose_key(a), b.to_ascii_lowercase()),
        None => (want_name.clone(), String::new()),
    };
    if want_name.is_empty() { return None; }
    let mut exact_name: Vec<String> = Vec::new();
    let mut partial: Vec<(usize, String)> = Vec::new();
    // Nom court (« CV.pdf ») : accepté seulement s'il désigne UN fichier.
    let mut prefix: Vec<String> = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            seen += 1;
            if seen > 8000 { break; }
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            if p.is_dir() {
                if depth < 10 { stack.push((p, depth + 1)); }
                continue;
            }
            let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            if loose_key(&rel) == want_rel { return Some(rel); }
            let key = loose_key(&name);
            if key == want_name {
                exact_name.push(rel);
                continue;
            }
            let (stem, ext) = match name.rsplit_once('.') {
                Some((a, b)) => (loose_key(a), b.to_ascii_lowercase()),
                None => (key.clone(), String::new()),
            };
            let same_ext = want_ext.is_empty() || ext == want_ext;
            if same_ext && stem.len() >= 4 && want_stem.len() >= 4 && (stem.contains(&want_stem) || want_stem.contains(&stem)) {
                partial.push((stem.len().abs_diff(want_stem.len()), rel));
            } else if same_ext && !want_ext.is_empty() && want_stem.len() >= 2 && stem.starts_with(&want_stem) {
                prefix.push(rel);
            }
        }
    }
    if exact_name.len() == 1 { return exact_name.pop(); }
    if !exact_name.is_empty() {
        // Même fichier en plusieurs exemplaires : le moins profond.
        exact_name.sort_by_key(|r| r.matches('/').count());
        return exact_name.into_iter().next();
    }
    partial.sort_by_key(|(d, _)| *d);
    if partial.is_empty() && prefix.len() == 1 { return prefix.pop(); }
    match partial.as_slice() {
        [(d, r)] => Some(r.clone()).filter(|_| *d < 40),
        [(d0, r0), (d1, _), ..] if d0 < d1 => Some(r0.clone()),
        _ => None,
    }
}

#[derive(Serialize)]
pub struct DocumentText {
    /// Chemin réel (peut différer de celui demandé).
    pub path: String,
    pub content: String,
    /// Texte tiré d'un document (PDF, Word…) plutôt que lu tel quel.
    pub extracted: bool,
    pub truncated: bool,
    pub size: u64,
}

const MAX_DOC_CHARS: usize = 60_000;

#[tauri::command]
pub async fn sandbox_read_document(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    id: String,
    path: String,
) -> Result<DocumentText, String> {
    require_session(&app, &session)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = sandbox_root(&app, &id)?;
        let clean = path.trim().trim_start_matches('/').to_string();
        let rel = match resolve(&root, &clean) {
            Ok(p) if p.is_file() => clean.clone(),
            _ => find_loose(&root, &clean).ok_or_else(|| format!("Fichier introuvable : « {clean} ».") )?,
        };
        let file = resolve(&root, &rel)?;
        let bytes = fs::read(&file).map_err(|e| e.to_string())?;
        let size = bytes.len() as u64;
        let ext = crate::rag::ext_of(&rel);
        let (text, extracted) = if crate::rag::RICH_DOC_EXTS.contains(&ext.as_str()) {
            (crate::rag::extract_document_text(&rel, &bytes)?, true)
        } else if crate::rag::IMAGE_EXTS.contains(&ext.as_str()) {
            return Err("Image : pas de texte à lire (utilise la vision pour la décrire).".into());
        } else {
            match std::str::from_utf8(&bytes) {
                Ok(s) if !s.contains('\0') => (s.to_string(), false),
                _ => return Err(format!("Fichier binaire (.{ext}) : aucun texte lisible.")),
            }
        };
        let truncated = text.chars().count() > MAX_DOC_CHARS;
        let content = if truncated { text.chars().take(MAX_DOC_CHARS).collect() } else { text };
        Ok(DocumentText { path: rel, content, extracted, truncated, size })
    })
    .await
    .map_err(|e| format!("Lecture interrompue : {e}"))?
}

#[cfg(test)]
mod loose_path_tests {
    use super::*;

    #[test]
    fn cle_tolerante() {
        assert_eq!(loose_key("CV_Andre_MARTIN 2026.pdf"), loose_key("cv andre martin_2026.PDF"));
        // é composé (NFC) et décomposé (NFD) donnent la même clé.
        assert_eq!(loose_key("Résumé.pdf"), loose_key("Re\u{301}sume\u{301}.pdf"));
    }

    #[test]
    fn retrouve_malgre_le_nom_et_le_dossier() {
        let dir = std::env::temp_dir().join(format!("lumen-loose-{}", std::process::id()));
        let sub = dir.join("sample-folder");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("CV_Andre_MARTIN 2026.pdf"), b"x").unwrap();
        fs::write(dir.join("Lettre de motivation.docx"), b"x").unwrap();
        assert_eq!(find_loose(&dir, "CV_Andre_MARTIN_2026.pdf").as_deref(), Some("sample-folder/CV_Andre_MARTIN 2026.pdf"));
        assert_eq!(find_loose(&dir, "CV André Martin 2026.pdf").as_deref(), Some("sample-folder/CV_Andre_MARTIN 2026.pdf"));
        assert_eq!(find_loose(&dir, "Maison/CV_Andre_MARTIN 2026.pdf").as_deref(), Some("sample-folder/CV_Andre_MARTIN 2026.pdf"));
        assert_eq!(find_loose(&dir, "CV_Andre_MARTIN.pdf").as_deref(), Some("sample-folder/CV_Andre_MARTIN 2026.pdf"));
        assert_eq!(find_loose(&dir, "facture.pdf"), None);
        // Nom court : un seul PDF commence par « cv » → trouvé ; « .docx » ne s'y confond pas.
        assert_eq!(find_loose(&dir, "CV.pdf").as_deref(), Some("sample-folder/CV_Andre_MARTIN 2026.pdf"));
        assert_eq!(find_loose(&dir, "CV.docx"), None);
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod local_sandbox_probe {
    use super::*;
    /// LUMEN_SANDBOX_PROBE=<racine de sandbox> cargo test --lib local_sandbox_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn probe() {
        let Ok(root) = std::env::var("LUMEN_SANDBOX_PROBE") else { return };
        let root = PathBuf::from(root);
        for wanted in ["CV_Andre_MARTIN 2026.pdf", "CV_Andre_MARTIN_2026.pdf", "CV André Martin 2026.pdf", "Projets/CV_Andre_MARTIN 2026.pdf", "cv_andre_martin.pdf", "CV.pdf"] {
            match find_loose(&root, wanted) {
                Some(rel) => {
                    let bytes = fs::read(root.join(&rel)).unwrap();
                    let text = crate::rag::extract_document_text(&rel, &bytes).unwrap_or_default();
                    println!("{wanted:40} → trouvé ({} car. extraits)", text.chars().count());
                }
                None => println!("{wanted:40} → introuvable"),
            }
        }
    }
}

// ===== Candidats pour un nom de fichier (lever les ambiguïtés) =====

#[derive(Serialize)]
pub struct FileCandidate {
    pub id: String,
    pub sandbox: String,
    pub path: String,
    pub size: u64,
    /// Dernière modification, ms epoch (0 si inconnue).
    pub modified: u64,
}

/// Tous les fichiers des sandboxes `ids` dont le nom correspond (même clé
/// tolérante que `find_loose`, ou nom qui contient / est contenu dans celui
/// demandé, même extension). Sert à DEMANDER à l'utilisateur quand plusieurs
/// fichiers différents répondent au même nom, plutôt que de deviner.
#[tauri::command]
pub fn sandbox_file_candidates(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    ids: Vec<String>,
    name: String,
) -> Result<Vec<FileCandidate>, String> {
    require_session(&app, &session)?;
    let wanted = name.rsplit(['/', '\\']).next().unwrap_or(&name).to_string();
    let want_key = loose_key(&wanted);
    let (want_stem, want_ext) = match wanted.rsplit_once('.') {
        Some((a, b)) => (loose_key(a), b.to_ascii_lowercase()),
        None => (want_key.clone(), String::new()),
    };
    if want_stem.len() < 2 { return Ok(Vec::new()); }
    let metas = sandbox_list_unchecked(&app)?;
    let mut out = Vec::new();
    for sb in metas.iter().filter(|m| ids.iter().any(|i| i == &m.id)) {
        let Ok(root) = sandbox_root(&app, &sb.id) else { continue };
        let mut stack = vec![(root.clone(), 0usize)];
        let mut seen = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                seen += 1;
                if seen > 8000 || out.len() > 40 { break; }
                let p = e.path();
                let fname = e.file_name().to_string_lossy().to_string();
                if fname.starts_with('.') { continue; }
                if p.is_dir() { if depth < 10 { stack.push((p, depth + 1)); } continue; }
                let key = loose_key(&fname);
                let (stem, ext) = match fname.rsplit_once('.') {
                    Some((a, b)) => (loose_key(a), b.to_ascii_lowercase()),
                    None => (key.clone(), String::new()),
                };
                let same_ext = want_ext.is_empty() || ext == want_ext;
                let hit = key == want_key
                    || (same_ext && stem.len() >= 2 && (stem.contains(&want_stem) || (want_stem.len() >= 4 && want_stem.contains(&stem) && stem.len() >= 4)));
                if !hit { continue; }
                let md = e.metadata().ok();
                out.push(FileCandidate {
                    id: sb.id.clone(),
                    sandbox: sb.name.clone(),
                    path: p.strip_prefix(&root).unwrap_or(&p).to_string_lossy().replace('\\', "/"),
                    size: md.as_ref().map(|m| m.len()).unwrap_or(0),
                    modified: md.and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64).unwrap_or(0),
                });
            }
        }
    }
    Ok(out)
}
