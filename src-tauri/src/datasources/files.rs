//! Connecteurs **fichiers** : CSV et classeurs Excel/OpenDocument.
//!
//! Une source fichier a une **racine** (`path` : un fichier ou un dossier) et ne
//! voit rien au-dessus : tout chemin demandé est recollé à la racine puis
//! vérifié par `canonicalize`, ce qui neutralise aussi bien `..` qu'un lien
//! symbolique qui pointerait ailleurs. C'est le même principe de confinement que
//! la sandbox de Lumen.
//!
//! Nommage des jeux de données :
//!   * CSV — un jeu = un fichier (`ventes/2026.csv`) ;
//!   * Excel — un jeu = une feuille, notée `classeur.xlsx#Feuille1` ; quand la
//!     racine est un classeur unique, le préfixe est facultatif.

use super::{safe_path, DataSource, Dataset, ObjectEntry, Page, ReadOpts, MAX_OBJECT_BYTES};
use calamine::{Data, Reader};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Racine de la source, résolue une fois. Erreur si elle n'existe pas : mieux
/// vaut une phrase claire qu'une liste vide inexplicable.
fn root(src: &DataSource) -> Result<PathBuf, String> {
    let raw = src.cfg("path");
    if raw.is_empty() {
        return Err("Renseignez le chemin du fichier ou du dossier.".into());
    }
    std::fs::canonicalize(&raw).map_err(|e| format!("Chemin introuvable ({raw}) : {e}"))
}

/// Résout `rel` **sous** la racine. Le `canonicalize` final est la garde qui
/// compte : un lien symbolique sortant est rejeté comme le serait `../..`.
fn resolve(src: &DataSource, rel: &str) -> Result<PathBuf, String> {
    let root = root(src)?;
    let rel = safe_path(rel)?;
    if rel.is_empty() {
        return Ok(root);
    }
    if root.is_file() {
        return Ok(root);
    }
    let joined = root.join(&rel);
    let full = std::fs::canonicalize(&joined).map_err(|e| format!("Fichier introuvable ({rel}) : {e}"))?;
    if !full.starts_with(&root) {
        return Err("Chemin hors de la source".into());
    }
    Ok(full)
}

fn extension(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase()
}

fn is_workbook(p: &Path) -> bool {
    matches!(extension(p).as_str(), "xlsx" | "xlsm" | "xlsb" | "xls" | "ods")
}

fn is_csv(p: &Path) -> bool {
    matches!(extension(p).as_str(), "csv" | "tsv")
}

/// Fichiers pertinents sous la racine, en profondeur, chemins relatifs.
fn walk(root: &Path, keep: fn(&Path) -> bool) -> Vec<(String, PathBuf)> {
    fn rec(root: &Path, dir: &Path, keep: fn(&Path) -> bool, out: &mut Vec<(String, PathBuf)>, depth: usize) {
        if depth > 6 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                rec(root, &p, keep, out, depth + 1);
            } else if keep(&p) {
                if let Ok(rel) = p.strip_prefix(root) {
                    out.push((rel.to_string_lossy().replace('\\', "/"), p.clone()));
                }
            }
        }
    }
    if root.is_file() {
        return if keep(root) {
            vec![(root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), root.to_path_buf())]
        } else {
            Vec::new()
        };
    }
    let mut out = Vec::new();
    rec(root, root, keep, &mut out, 0);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

// ===================== Opérations =====================

pub fn ping(src: &DataSource) -> Result<String, String> {
    let root = root(src)?;
    let n = list_datasets_inner(src)?.len();
    Ok(format!("{} — {n} jeu(x) de données.", root.display()))
}

pub fn datasets(src: &DataSource) -> Result<Vec<Dataset>, String> {
    list_datasets_inner(src)
}

fn list_datasets_inner(src: &DataSource) -> Result<Vec<Dataset>, String> {
    let root = root(src)?;
    let mut out = Vec::new();
    if src.kind == "csv" {
        for (rel, path) in walk(&root, is_csv) {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            out.push(Dataset { name: rel, schema: String::new(), rows: None, note: format!("{size} octets") });
        }
    } else {
        for (rel, path) in walk(&root, is_workbook) {
            let wb = calamine::open_workbook_auto(&path).map_err(|e| format!("{rel} : {e}"))?;
            for sheet in wb.sheet_names() {
                out.push(Dataset {
                    name: format!("{rel}#{sheet}"),
                    schema: rel.clone(),
                    rows: None,
                    note: "feuille".into(),
                });
            }
        }
    }
    Ok(out)
}

/// Découpe `classeur.xlsx#Feuille` ; quand la racine est un classeur unique, le
/// nom du fichier peut être omis.
fn split_sheet(src: &DataSource, dataset: &str) -> Result<(String, String), String> {
    match dataset.split_once('#') {
        Some((file, sheet)) => Ok((file.to_string(), sheet.to_string())),
        None => {
            let root = root(src)?;
            if root.is_file() {
                Ok((root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), dataset.to_string()))
            } else {
                Err("Nommez la feuille sous la forme « classeur.xlsx#Feuille ».".into())
            }
        }
    }
}

fn cell(value: &Data) -> Value {
    match value {
        Data::Empty => Value::Null,
        Data::String(s) => json!(s),
        Data::Float(f) => json!(f),
        Data::Int(i) => json!(i),
        Data::Bool(b) => json!(b),
        Data::DateTime(d) => json!(d.as_f64()),
        Data::DateTimeIso(s) => json!(s),
        Data::DurationIso(s) => json!(s),
        Data::Error(e) => json!(format!("#{e:?}")),
    }
}

/// Lit une grille (en-tête + lignes) depuis un CSV ou une feuille.
fn grid(src: &DataSource, dataset: &str, max_rows: usize, skip: usize) -> Result<(Vec<String>, Vec<Vec<Value>>), String> {
    if src.kind == "csv" {
        let path = resolve(src, dataset)?;
        let delimiter = match src.cfg("delimiter").as_str() {
            ";" => b';',
            "\t" | "tab" => b'\t',
            "|" => b'|',
            _ => b',',
        };
        let mut reader = csv::ReaderBuilder::new()
            .delimiter(delimiter)
            .flexible(true)
            .from_path(&path)
            .map_err(|e| format!("Lecture impossible : {e}"))?;
        let headers = reader
            .headers()
            .map_err(|e| e.to_string())?
            .iter()
            .map(|h| h.to_string())
            .collect::<Vec<_>>();
        let mut rows = Vec::new();
        for (i, rec) in reader.records().enumerate() {
            if i < skip {
                continue;
            }
            if rows.len() >= max_rows {
                break;
            }
            let rec = rec.map_err(|e| e.to_string())?;
            rows.push(rec.iter().map(|f| json!(f)).collect());
        }
        return Ok((headers, rows));
    }

    let (file, sheet) = split_sheet(src, dataset)?;
    let path = resolve(src, &file)?;
    let mut wb = calamine::open_workbook_auto(&path).map_err(|e| e.to_string())?;
    let range = wb
        .worksheet_range(&sheet)
        .map_err(|_| format!("Feuille « {sheet} » introuvable dans {file}."))?;
    let mut iter = range.rows();
    let headers: Vec<String> = iter
        .next()
        .map(|r| r.iter().enumerate().map(|(i, c)| {
            let raw = cell(c);
            match raw.as_str() {
                Some(s) if !s.trim().is_empty() => s.to_string(),
                _ if raw.is_null() => format!("col{}", i + 1),
                _ => raw.to_string(),
            }
        }).collect())
        .unwrap_or_default();
    let rows = iter
        .skip(skip)
        .take(max_rows)
        .map(|r| r.iter().map(cell).collect())
        .collect();
    Ok((headers, rows))
}

pub fn schema(src: &DataSource, dataset: &str) -> Result<Value, String> {
    // Le type d'une colonne se déduit d'un échantillon : ces formats n'en
    // déclarent aucun. On annonce donc « inféré », sans le déguiser en vérité.
    let (headers, rows) = grid(src, dataset, 50, 0)?;
    let cols: Vec<Value> = headers
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let kind = rows
                .iter()
                .filter_map(|r| r.get(i))
                .find(|v| !v.is_null())
                .map(|v| match v {
                    Value::Number(_) => "number",
                    Value::Bool(_) => "boolean",
                    _ => "text",
                })
                .unwrap_or("text");
            json!({ "name": name, "type": kind, "inferred": true })
        })
        .collect();
    Ok(json!({ "dataset": dataset, "columns": cols, "sampledRows": rows.len() }))
}

pub fn rows(src: &DataSource, dataset: &str, opts: &ReadOpts) -> Result<Page, String> {
    let limit = opts.bounded_limit();
    let offset = opts.offset.max(0);
    let (headers, mut data) = grid(src, dataset, limit as usize, offset as usize)?;

    // Filtres et projection s'appliquent après lecture : ces formats n'ont pas
    // de moteur de requête, et les inventer donnerait une illusion de sélectivité.
    if !opts.filters.is_empty() {
        data.retain(|row| {
            opts.filters.iter().all(|(col, want)| {
                headers
                    .iter()
                    .position(|h| h == col)
                    .and_then(|i| row.get(i))
                    .map(|v| v.as_str().map(|s| s == want).unwrap_or_else(|| v.to_string() == *want))
                    .unwrap_or(false)
            })
        });
    }
    if opts.select.is_empty() {
        let truncated = data.len() as i64 >= limit;
        return Ok(Page { columns: headers, rows: data, limit, offset, truncated });
    }
    let idx: Vec<usize> = opts
        .select
        .iter()
        .filter_map(|c| headers.iter().position(|h| h == c))
        .collect();
    let columns = idx.iter().map(|i| headers[*i].clone()).collect();
    let rows: Vec<Vec<Value>> = data
        .iter()
        .map(|r| idx.iter().map(|i| r.get(*i).cloned().unwrap_or(Value::Null)).collect())
        .collect();
    let truncated = rows.len() as i64 >= limit;
    Ok(Page { columns, rows, limit, offset, truncated })
}

pub fn objects(src: &DataSource, path: &str) -> Result<Vec<ObjectEntry>, String> {
    let dir = resolve(src, path)?;
    if dir.is_file() {
        let meta = std::fs::metadata(&dir).map_err(|e| e.to_string())?;
        return Ok(vec![ObjectEntry {
            path: path.to_string(),
            name: dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            dir: false,
            size: Some(meta.len()),
            modified: String::new(),
            mime: String::new(),
        }]);
    }
    let base = root(src)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        let rel = p.strip_prefix(&base).unwrap_or(&p).to_string_lossy().replace('\\', "/");
        let meta = entry.metadata().ok();
        out.push(ObjectEntry {
            path: rel,
            name: entry.file_name().to_string_lossy().to_string(),
            dir: p.is_dir(),
            size: meta.as_ref().map(|m| m.len()),
            modified: String::new(),
            mime: extension(&p),
        });
    }
    out.sort_by(|a, b| (b.dir, a.name.to_lowercase()).cmp(&(a.dir, b.name.to_lowercase())));
    Ok(out)
}

pub fn object(src: &DataSource, path: &str) -> Result<Value, String> {
    let full = resolve(src, path)?;
    let meta = std::fs::metadata(&full).map_err(|e| e.to_string())?;
    if meta.len() as usize > MAX_OBJECT_BYTES {
        return Err(format!("Fichier trop volumineux ({} octets).", meta.len()));
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    Ok(super::remote::payload(path, &extension(&full), bytes))
}
