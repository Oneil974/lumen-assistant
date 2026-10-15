//! Bibliothèque de skills au format « Agent Skills » (dossier + `SKILL.md`).
//!
//! Un skill = un dossier contenant `SKILL.md` (en-tête YAML `name` +
//! `description`, puis des instructions en Markdown) et, au besoin, des
//! fichiers de référence (modèles, exemples, scripts). Format répandu (Claude,
//! d'autres agents) : on peut importer un skill écrit ailleurs, ou exporter
//! ceux de Lumen.
//!
//! Divulgation progressive, comme le prévoit le format : le modèle ne voit
//! d'abord que la liste « nom — description » (outil `skills_list`), puis lit
//! le skill utile (`skill_read`) et, si besoin, un de ses fichiers
//! (`skill_file`). Les scripts éventuels ne sont JAMAIS exécutés par Lumen :
//! ils restent lisibles, l'utilisateur ou un agent peut les reprendre dans
//! l'app Python ou un workflow Fluxo.
//!
//! Stockage : `<données>/skills/<nom>/…`.

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_FILE: u64 = 512 * 1024;

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?.join("skills");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn slug(s: &str) -> String {
    let out: String = s.trim().to_lowercase().chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    out.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-")
}

/// En-tête YAML minimal (`name`, `description`), sans dépendance YAML.
fn frontmatter(md: &str) -> (String, String, String) {
    let t = md.trim_start_matches('\u{feff}');
    if let Some(rest) = t.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let head = &rest[..end];
            let body = rest[end + 4..].trim_start_matches(['-', '\r', '\n']).to_string();
            let get = |k: &str| head.lines().find_map(|l| {
                let l = l.trim();
                l.strip_prefix(&format!("{k}:")).map(|v| v.trim().trim_matches(['"', '\'']).to_string())
            }).unwrap_or_default();
            return (get("name"), get("description"), body);
        }
    }
    (String::new(), String::new(), t.to_string())
}

#[derive(Serialize, Clone)]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub files: Vec<String>,
}

fn list_files(dir: &Path, base: &Path, out: &mut Vec<String>) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.starts_with("._") { continue; }
            if p.is_dir() { list_files(&p, base, out); }
            else if let Ok(rel) = p.strip_prefix(base) { out.push(rel.to_string_lossy().replace('\\', "/")); }
        }
    }
}

pub fn list(app: &tauri::AppHandle) -> Vec<SkillInfo> {
    let Ok(r) = root(app) else { return Vec::new() };
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&r) {
        for e in rd.flatten() {
            let dir = e.path();
            let md = dir.join("SKILL.md");
            if !md.is_file() { continue; }
            let (name, description, _) = frontmatter(&fs::read_to_string(&md).unwrap_or_default());
            let id = e.file_name().to_string_lossy().to_string();
            let mut files = Vec::new();
            list_files(&dir, &dir, &mut files);
            files.sort();
            out.push(SkillInfo { name: if name.is_empty() { id.clone() } else { name }, id, description, files });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn find(app: &tauri::AppHandle, key: &str) -> Option<(PathBuf, SkillInfo)> {
    let k = key.trim().to_lowercase();
    let r = root(app).ok()?;
    list(app).into_iter().find(|s| s.id == k || s.name.to_lowercase() == k || slug(&s.name) == slug(&k)).map(|s| (r.join(&s.id), s))
}

/// Texte complet d'un skill (instructions), avec la liste de ses fichiers.
pub fn read(app: &tauri::AppHandle, key: &str) -> Result<String, String> {
    let (dir, info) = find(app, key).ok_or_else(|| format!("Skill introuvable : {key}. Appelle skills_list."))?;
    let md = fs::read_to_string(dir.join("SKILL.md")).map_err(|e| e.to_string())?;
    let (_, _, body) = frontmatter(&md);
    let others: Vec<&String> = info.files.iter().filter(|f| f.as_str() != "SKILL.md").collect();
    Ok(format!(
        "# Skill : {}\n{}\n\n{}{}",
        info.name, info.description, body.trim(),
        if others.is_empty() { String::new() } else {
            format!("\n\n---\nFichiers du skill (à lire avec skill_file si utile) : {}", others.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "))
        }
    ))
}

/// Un fichier d'un skill (chemin relatif, sans remontée de dossier).
pub fn read_file(app: &tauri::AppHandle, key: &str, rel: &str) -> Result<String, String> {
    let (dir, _) = find(app, key).ok_or_else(|| format!("Skill introuvable : {key}"))?;
    if rel.contains("..") || rel.starts_with('/') || rel.contains(':') { return Err("chemin refusé".into()); }
    let p = dir.join(rel);
    let meta = fs::metadata(&p).map_err(|_| format!("Fichier absent du skill : {rel}"))?;
    if meta.len() > MAX_FILE { return Err("fichier trop volumineux pour être lu ici".into()); }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "fichier binaire : non lisible en texte".into())
}

/// Importe un skill depuis un dossier (contenant SKILL.md) ou une archive .zip/.skill.
#[tauri::command]
pub fn agentskill_import(app: tauri::AppHandle, path: String) -> Result<SkillInfo, String> {
    let src = PathBuf::from(&path);
    let r = root(&app)?;
    let tmp = r.join(format!(".import-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    if src.is_dir() {
        copy_dir(&src, &tmp)?;
    } else {
        let f = fs::File::open(&src).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("archive illisible : {e}"))?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            let Some(name) = entry.enclosed_name() else { continue };
            let out = tmp.join(name);
            if entry.is_dir() { fs::create_dir_all(&out).ok(); continue; }
            if let Some(p) = out.parent() { fs::create_dir_all(p).ok(); }
            let mut w = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut w).map_err(|e| e.to_string())?;
        }
    }
    // SKILL.md à la racine, ou dans l'unique sous-dossier de l'archive.
    let mut base = tmp.clone();
    if !base.join("SKILL.md").is_file() {
        let subs: Vec<PathBuf> = fs::read_dir(&tmp).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).filter(|p| p.join("SKILL.md").is_file()).collect();
        if let [one] = subs.as_slice() { base = one.clone(); } else {
            let _ = fs::remove_dir_all(&tmp);
            return Err("Aucun SKILL.md trouvé : un skill est un dossier contenant SKILL.md.".into());
        }
    }
    let (name, _, _) = frontmatter(&fs::read_to_string(base.join("SKILL.md")).unwrap_or_default());
    let id = slug(if name.is_empty() { src.file_stem().and_then(|s| s.to_str()).unwrap_or("skill") } else { &name });
    let dest = r.join(&id);
    let _ = fs::remove_dir_all(&dest);
    fs::rename(&base, &dest).or_else(|_| copy_dir(&base, &dest))?;
    let _ = fs::remove_dir_all(&tmp);
    list(&app).into_iter().find(|s| s.id == id).ok_or_else(|| "import incomplet".into())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with("._") || name == ".DS_Store" { continue; }
        let (s, d) = (e.path(), to.join(&name));
        if s.is_dir() { copy_dir(&s, &d)?; } else { fs::copy(&s, &d).map_err(|e| e.to_string())?; }
    }
    Ok(())
}

#[tauri::command]
pub fn agentskill_list(app: tauri::AppHandle) -> Vec<SkillInfo> { list(&app) }

#[tauri::command]
pub fn agentskill_get(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    let (dir, info) = find(&app, &id).ok_or("skill introuvable")?;
    Ok(json!({ "info": info, "markdown": fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default() }))
}

/// Crée ou réécrit un skill (éditeur de Lumen) : `markdown` = SKILL.md complet.
#[tauri::command]
pub fn agentskill_save(app: tauri::AppHandle, markdown: String) -> Result<SkillInfo, String> {
    let (name, description, _) = frontmatter(&markdown);
    if name.trim().is_empty() || description.trim().is_empty() {
        return Err("L'en-tête doit contenir name: et description: (entre deux lignes ---).".into());
    }
    let id = slug(&name);
    let dir = root(&app)?.join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("SKILL.md"), markdown).map_err(|e| e.to_string())?;
    list(&app).into_iter().find(|s| s.id == id).ok_or_else(|| "écriture incomplète".into())
}

#[tauri::command]
pub fn agentskill_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let r = root(&app)?;
    let dir = r.join(slug(&id));
    if !dir.starts_with(&r) || !dir.join("SKILL.md").is_file() { return Err("skill introuvable".into()); }
    fs::remove_dir_all(dir).map_err(|e| e.to_string())
}

/// Exporte un skill en archive .zip (partage vers un autre outil).
#[tauri::command]
pub fn agentskill_export(app: tauri::AppHandle, id: String, dest_dir: String) -> Result<String, String> {
    use std::io::Write;
    let (dir, info) = find(&app, &id).ok_or("skill introuvable")?;
    let dir_out = if dest_dir.trim().is_empty() {
        app.path().download_dir().map_err(|e| e.to_string())?
    } else { PathBuf::from(dest_dir) };
    let out = dir_out.join(format!("{}.zip", info.id));
    let f = fs::File::create(&out).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(f);
    let opts = zip::write::SimpleFileOptions::default();
    for rel in &info.files {
        zip.start_file(format!("{}/{}", info.id, rel), opts).map_err(|e| e.to_string())?;
        zip.write_all(&fs::read(dir.join(rel)).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(out.display().to_string())
}

/// Bloc de prompt : liste « nom — description » des skills (divulgation progressive).
pub fn prompt_index(app: &tauri::AppHandle) -> String {
    let l = list(app);
    if l.is_empty() { return String::new(); }
    format!(
        "\n\n=== Skills disponibles (lis-en un avec skill_read AVANT une tâche qui correspond) ===\n{}",
        l.iter().map(|s| format!("- {} — {}", s.name, s.description)).collect::<Vec<_>>().join("\n")
    )
}
