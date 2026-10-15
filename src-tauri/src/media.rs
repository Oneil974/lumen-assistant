//! Médias de l'app « Médias » (lecteur + montage vidéo).
//!
//! 1. **Schéma `lumenmedia://`** — une vidéo de 2 Go ne peut pas transiter en
//!    base64 par l'IPC. Ce schéma sert un fichier de sandbox directement à la
//!    WebView, AVEC les requêtes partielles (`Range`) qu'exigent l'avance
//!    rapide et WebKit (qui refuse de lire une vidéo sans elles). URL :
//!    `lumenmedia://localhost/<sandbox>/<chemin encodé>` (macOS/Linux) ou
//!    `http://lumenmedia.localhost/…` (Windows). Session verrouillée → 403.
//!    `Access-Control-Allow-Origin: *` : sans lui, dessiner la vidéo dans un
//!    canvas le « salit » et l'export du montage (captureStream) est refusé.
//! 2. **Écriture par morceaux** (`media_append_b64`) — l'export du montage
//!    arrive par tranches de quelques Mo plutôt qu'en un seul message géant.
//! 3. **ffmpeg, s'il est installé** — convertir ce que le moteur ne lit pas
//!    (MKV, AVI…) et produire un MP4 H.264 universel. Rien n'est téléchargé :
//!    sans ffmpeg, l'app garde l'export natif du moteur.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::Command;
use tauri::http::{Request, Response};
use tauri::Manager;

const MAX_CHUNK: u64 = 4 * 1024 * 1024;

pub(crate) fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" | "csv" => "text/plain; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn reply(status: u16, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("access-control-allow-origin", "*")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

/// `lumenmedia://localhost/<sb>/<chemin>` → (sb, chemin décodé).
pub(crate) fn split(uri: &str) -> Option<(String, String)> {
    let rest = uri
        .strip_prefix("lumenmedia://localhost/")
        .or_else(|| uri.strip_prefix("http://lumenmedia.localhost/"))
        .or_else(|| uri.strip_prefix("https://lumenmedia.localhost/"))?;
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (sb, path) = rest.split_once('/')?;
    let path: String = url::form_urlencoded::parse(format!("p={}", path.replace('+', "%2B")).as_bytes())
        .find(|(k, _)| k == "p")
        .map(|(_, v)| v.into_owned())?;
    if sb.is_empty() || path.is_empty() {
        return None;
    }
    Some((sb.to_string(), path))
}

/// `bytes=a-b` → (début, fin incluse), bornés à la taille du fichier.
fn parse_range(h: &str, size: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if size == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (size.saturating_sub(n), size - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { size - 1 } else { b.parse::<u64>().ok()?.min(size - 1) };
        (start, end)
    };
    if start > end || start >= size {
        return None;
    }
    // Plage ouverte : on sert un morceau raisonnable, le lecteur redemandera.
    Some((start, end.min(start + MAX_CHUNK - 1)))
}

pub fn handle(app: &tauri::AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() == "OPTIONS" {
        return Response::builder()
            .status(204)
            .header("access-control-allow-origin", "*")
            .header("access-control-allow-headers", "range")
            .body(Vec::new())
            .unwrap();
    }
    let state = app.state::<crate::session::SessionState>();
    if !crate::session::is_unlocked(app, state.inner()) {
        return reply(403, "session verrouillée");
    }
    let uri = request.uri().to_string();
    let Some((sb, rel)) = split(&uri) else { return reply(400, "adresse média invalide") };
    let Ok(path) = crate::sandbox::sandbox_file_path(app, &sb, &rel) else { return reply(404, "hors sandbox") };
    let Ok(mut file) = File::open(&path) else { return reply(404, "fichier introuvable") };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mime = mime_of(&rel);
    let range = request.headers().get("range").and_then(|v| v.to_str().ok()).map(String::from);
    let (status, start, end) = match range.as_deref().and_then(|r| parse_range(r, size)) {
        Some((s, e)) => (206, s, e),
        None if range.is_some() && size > 0 => {
            return Response::builder()
                .status(416)
                .header("content-range", format!("bytes */{size}"))
                .header("access-control-allow-origin", "*")
                .body(Vec::new())
                .unwrap()
        }
        // Sans Range : fichier entier s'il est petit, sinon un premier morceau
        // annoncé en 206 (WebKit enchaîne alors en requêtes partielles).
        None if size > MAX_CHUNK => (206, 0, MAX_CHUNK - 1),
        None => (200, 0, size.saturating_sub(1)),
    };
    let len = if size == 0 { 0 } else { end - start + 1 };
    let mut buf = vec![0u8; len as usize];
    if len > 0 && (file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err()) {
        return reply(500, "lecture impossible");
    }
    let mut resp = Response::builder()
        .status(status)
        .header("content-type", mime)
        .header("accept-ranges", "bytes")
        .header("content-length", len.to_string())
        .header("access-control-allow-origin", "*")
        .header("access-control-expose-headers", "content-range, content-length, accept-ranges")
        .header("cache-control", "no-store");
    if status == 206 {
        resp = resp.header("content-range", format!("bytes {start}-{end}/{size}"));
    }
    resp.body(buf).unwrap_or_else(|_| reply(500, "réponse impossible"))
}

/// Ajoute un morceau (base64) à un fichier de sandbox ; `reset` le recrée.
/// Sert à l'export du montage, envoyé par tranches.
#[tauri::command]
pub fn media_append_b64(
    app: tauri::AppHandle,
    session: tauri::State<'_, crate::session::SessionState>,
    sandbox_id: String,
    path: String,
    data_b64: String,
    reset: bool,
) -> Result<u64, String> {
    crate::session::require_unlocked(&app, session.inner())?;
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD.decode(data_b64.as_bytes()).map_err(|e| e.to_string())?;
    let target = crate::sandbox::sandbox_file_path(&app, &sandbox_id, &path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = if reset {
        File::create(&target).map_err(|e| e.to_string())?
    } else {
        OpenOptions::new().append(true).create(true).open(&target).map_err(|e| e.to_string())?
    };
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(f.metadata().map(|m| m.len()).unwrap_or(0))
}

fn ffmpeg_path() -> Option<PathBuf> {
    let candidates = [
        "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg",
        "C:\\ffmpeg\\bin\\ffmpeg.exe", "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
    }
    // PATH du processus (Linux, Windows avec ffmpeg installé par winget/scoop).
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join(exe)).find(|p| p.is_file()))
}

#[tauri::command]
pub fn media_ffmpeg_status() -> serde_json::Value {
    match ffmpeg_path() {
        Some(p) => serde_json::json!({ "available": true, "path": p.to_string_lossy() }),
        None => serde_json::json!({ "available": false }),
    }
}

/// Convertit un fichier de sandbox en MP4 (H.264 + AAC) ou en M4A (audio seul)
/// avec ffmpeg ; renvoie le chemin produit, à côté de l'original.
#[tauri::command]
pub async fn media_convert(app: tauri::AppHandle, sandbox_id: String, path: String, audio_only: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::session::SessionState>();
        crate::session::require_unlocked(&app, state.inner())?;
        let ffmpeg = ffmpeg_path().ok_or("ffmpeg n'est pas installé sur cet ordinateur.")?;
        let input = crate::sandbox::sandbox_file_path(&app, &sandbox_id, &path)?;
        let audio = audio_only.unwrap_or(false);
        let stem = path.rsplit_once('.').map(|(s, _)| s).unwrap_or(&path);
        let mut out_rel = format!("{stem}{}.{}", if path.ends_with(".mp4") { " (converti)" } else { "" }, if audio { "m4a" } else { "mp4" });
        let mut n = 2;
        while crate::sandbox::sandbox_file_path(&app, &sandbox_id, &out_rel).map(|p| p.exists()).unwrap_or(false) {
            out_rel = format!("{stem} ({n}).{}", if audio { "m4a" } else { "mp4" });
            n += 1;
        }
        let output = crate::sandbox::sandbox_file_path(&app, &sandbox_id, &out_rel)?;
        let mut cmd = Command::new(ffmpeg);
        cmd.arg("-y").arg("-hide_banner").arg("-loglevel").arg("error").arg("-i").arg(&input);
        if audio {
            cmd.args(["-vn", "-c:a", "aac", "-b:a", "192k"]);
        } else {
            cmd.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]);
        }
        let out = cmd.arg(&output).output().map_err(|e| format!("ffmpeg n'a pas pu démarrer : {e}"))?;
        if !out.status.success() {
            let _ = fs::remove_file(&output);
            return Err(format!("Conversion échouée : {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")));
        }
        Ok(out_rel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_both_url_forms_and_decodes() {
        assert_eq!(split("lumenmedia://localhost/sb1/Vid%C3%A9os/f%20a.mp4"), Some(("sb1".into(), "Vidéos/f a.mp4".into())));
        assert_eq!(split("http://lumenmedia.localhost/sb1/a%2Bb.mp3"), Some(("sb1".into(), "a+b.mp3".into())));
        assert_eq!(split("lumenmedia://localhost/sb1/"), None);
    }

    #[test]
    fn ranges_are_bounded() {
        assert_eq!(parse_range("bytes=0-1", 100), Some((0, 1)));
        assert_eq!(parse_range("bytes=10-", 100), Some((10, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=200-", 100), None);
        assert_eq!(parse_range("bytes=0-", 10 * MAX_CHUNK), Some((0, MAX_CHUNK - 1)));
    }
}
