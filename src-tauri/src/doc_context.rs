//! Collecte de contexte pour la génération de documents (outils « @doc_* » des
//! barres de chat).
//!
//! Une lettre de motivation ou une présentation de produit n'a de valeur que si
//! elle part des VRAIS éléments de l'utilisateur : CV, fiche produit, notes…
//! Cette commande parcourt toutes les sandboxes, note chaque fichier selon les
//! mots-clés du brief (nom de fichier d'abord, contenu pour les fichiers texte),
//! puis extrait le texte des meilleurs candidats — PDF/Word/tableurs compris,
//! par le même extracteur que les agents (`native_tools::read_sandbox_document`).
//!
//! Les images sont volontairement écartées : les décrire coûterait un appel au
//! modèle vision par fichier, pour un gain faible sur un document rédigé.

use std::fs;
use std::path::PathBuf;

const TEXT_EXTS: &[&str] = &["md", "txt", "csv", "json", "tsv", "yaml", "yml", "rtf", "lumensheet"];
const MAX_WALK: usize = 4000;
const MAX_TEXT_SCAN: u64 = 256 * 1024;

#[derive(serde::Serialize)]
pub struct ContextFile {
    pub sandbox_id: String,
    pub sandbox_name: String,
    pub path: String,
    pub score: u32,
    pub text: String,
}

fn fold(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| match c {
            'à' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            _ => c,
        })
        .collect()
}

fn walk(root: &PathBuf) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            if out.len() >= MAX_WALK {
                return out;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // `._*` : métadonnées macOS sur un disque exFAT, jamais du contenu.
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out
}

/// Note un fichier : 6 points par mot-clé présent dans le chemin, 1 point par
/// occurrence dans le contenu (plafonné à 5 par mot) pour les fichiers texte.
fn score(rel: &str, ext: &str, full: &PathBuf, keys: &[String]) -> u32 {
    let name = fold(rel);
    let mut s = 0u32;
    for k in keys {
        if name.contains(k.as_str()) {
            s += 6;
        }
    }
    if TEXT_EXTS.contains(&ext) {
        if let Ok(meta) = fs::metadata(full) {
            if meta.len() <= MAX_TEXT_SCAN {
                if let Ok(body) = fs::read_to_string(full) {
                    let body = fold(&body);
                    for k in keys {
                        s += body.matches(k.as_str()).count().min(5) as u32;
                    }
                }
            }
        }
    }
    s
}

/// Fichiers de sandbox pertinents pour un brief, texte extrait compris.
/// `keywords` : mots significatifs (≥ 3 lettres) ; `max_files` borné à 6 ;
/// `max_chars` par fichier borné à 8 000.
#[tauri::command]
pub async fn doc_gather_context(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    keywords: Vec<String>,
    max_files: Option<usize>,
    max_chars: Option<usize>,
    // Sandboxes que l'utilisateur a autorisées (cf. lib/user-gate.js). Absent :
    // comportement historique (toutes) pour les appelants internes.
    sandbox_ids: Option<Vec<String>>,
) -> Result<Vec<ContextFile>, String> {
    // Les sandboxes sont gardées par la session : pas de lecture verrouillée.
    crate::session::require_unlocked(&app, session.inner())?;
    tauri::async_runtime::spawn_blocking(move || gather(&app, keywords, max_files, max_chars, sandbox_ids))
        .await
        .map_err(|e| e.to_string())?
}

fn gather(
    app: &tauri::AppHandle,
    keywords: Vec<String>,
    max_files: Option<usize>,
    max_chars: Option<usize>,
    only: Option<Vec<String>>,
) -> Result<Vec<ContextFile>, String> {
    let keys: Vec<String> = keywords
        .iter()
        .map(|k| fold(k.trim()))
        .filter(|k| k.chars().count() >= 3)
        .collect();
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let max_files = max_files.unwrap_or(4).clamp(1, 6);
    let max_chars = max_chars.unwrap_or(4000).clamp(500, 8000);

    let mut ranked: Vec<(u32, String, String, String)> = Vec::new();
    for sb in crate::sandbox::sandbox_list_unchecked(app)? {
        if let Some(ids) = &only {
            if !ids.iter().any(|id| id == &sb.id) { continue; }
        }
        let Ok(root) = crate::sandbox::root_path(app, &sb.id) else { continue };
        for full in walk(&root) {
            let rel = full
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let ext = crate::rag::ext_of(&rel);
            if !TEXT_EXTS.contains(&ext.as_str()) && !crate::rag::RICH_DOC_EXTS.contains(&ext.as_str()) {
                continue;
            }
            // Journaux d'agents : comptes rendus bruts, pas une source.
            if rel.starts_with("journal/") {
                continue;
            }
            let s = score(&rel, &ext, &full, &keys);
            if s > 0 {
                ranked.push((s, sb.id.clone(), sb.name.clone(), rel));
            }
        }
    }
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.3.cmp(&b.3)));

    let mut out = Vec::new();
    for (s, id, name, rel) in ranked.into_iter().take(max_files) {
        let (text, ok) = crate::native_tools::read_sandbox_document(app, &id, &rel, "");
        if !ok || text.trim().is_empty() {
            continue;
        }
        let text: String = text.chars().take(max_chars).collect();
        out.push(ContextFile { sandbox_id: id, sandbox_name: name, path: rel, score: s, text });
    }
    Ok(out)
}
