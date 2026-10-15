//! Service des applications installées — le schéma d'URL `lumenapp://`.
//!
//! Une app packagée vit dans le dossier de données, pas dans le bundle. Pour la
//! charger dans une iframe il faut donc une URL, et une SEULE origine par app :
//! `lumenapp://<id>/…`. Deux apps ne partagent ainsi ni stockage, ni cookies, ni
//! accès au DOM l'une de l'autre — c'est le navigateur qui l'impose, pas nous.
//!
//! Ce module fait deux choses, et rien de plus :
//!
//!   1. servir les fichiers du paquet, en refusant tout ce qui sort de son
//!      dossier ;
//!   2. injecter, dans les seules pages HTML, les deux ponts de l'AppKit — le
//!      relais IPC (`tauri-shim.js`) et le SDK (`guest.js`) — plus l'identité de
//!      l'app. Les ponts sont injectés en TÊTE de `<head>` : une app doit les
//!      trouver déjà en place au premier script qu'elle exécute.
//!
//! L'injection ne donne aucun pouvoir en soi : les deux ponts se contentent
//! d'envoyer des postMessage au bureau, qui vérifie. Cf. src/lib/appkit/host.js.

use tauri::http::{Request, Response};
use tauri::Manager;

/// Les deux ponts, embarqués à la compilation : ils doivent être disponibles
/// même si le frontend est servi depuis un dev-server distant.
const TAURI_SHIM: &str = include_str!("../../src/lib/appkit/tauri-shim.js");
const APPKIT_GUEST: &str = include_str!("../../src/lib/appkit/guest.js");

/// Découpe une URL `lumenapp://…` en (identifiant d'app, chemin).
///
/// Les plateformes ne s'accordent pas : macOS et Linux donnent
/// `lumenapp://<id>/<chemin>`. Sur Windows la page demande
/// `http://lumenapp.localhost/<id>/<chemin>`, et wry RETRADUIT cette forme en
/// `lumenapp://localhost/<id>/<chemin>` avant de nous appeler
/// (`custom_protocol_workaround::revert_uri_work_around`) : l'hôte vaut alors
/// `localhost` et l'identifiant est le premier segment du chemin. On accepte
/// les trois formes plutôt que de faire dépendre le reste du code de l'OS.
fn split_target(uri: &str) -> Option<(String, String)> {
    let rest = uri
        .strip_prefix("lumenapp://")
        .or_else(|| uri.strip_prefix("http://lumenapp.localhost/"))
        .or_else(|| uri.strip_prefix("https://lumenapp.localhost/"))?;
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let mut parts = rest.splitn(2, '/');
    let mut id = parts.next()?.to_string();
    let mut path = parts.next().unwrap_or("").to_string();
    if id == "localhost" {
        let mut inner = path.splitn(2, '/');
        id = inner.next().unwrap_or("").to_string();
        path = inner.next().unwrap_or("").to_string();
    }
    if id.is_empty() {
        return None;
    }
    Some((id, path))
}

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "glb" => "model/gltf-binary",
        _ => "application/octet-stream",
    }
}

fn not_found(message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(404)
        .header("content-type", "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Réglages de Lumen que l'app doit connaître AVANT d'exécuter son propre
/// code, sous la forme des clés `localStorage` que ses bibliothèques lisent
/// (`aiSource`, `selectedModel`…). Une app packagée vit sur sa propre origine :
/// son `localStorage` est vide, et sans ce relais elle croirait qu'aucune
/// source d'IA n'est configurée. guest.js pose ces clés au chargement ; l'hôte
/// les rafraîchit ensuite par l'événement `settings`.
fn settings_snapshot(app: &tauri::AppHandle) -> String {
    let raw = crate::paths::shared_data_dir(app.path())
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("ollama.json")).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    let get = |k: &str| raw.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let backend = get("backend");
    let mut out = serde_json::Map::new();
    let mut put = |k: &str, v: String| { if !v.is_empty() { out.insert(k.into(), serde_json::Value::String(v)); } };
    put("aiSource", if backend.is_empty() { "ollama".into() } else { backend.clone() });
    put("selectedModel", get("model"));
    put("ollamaUrl", get("url"));
    put("apiBaseUrl", get("api_base"));
    put("apiModel", if backend == "lumen" { String::new() } else { get("api_model") });
    put("lumenModel", if backend == "lumen" { get("api_model") } else { String::new() });
    put("lang", get("language"));
    put("systemPrompt", get("system_prompt"));
    let ctx = raw.get("num_ctx").and_then(|v| v.as_u64()).unwrap_or(0);
    if ctx > 0 { put("ollamaNumCtx", ctx.to_string()); }
    // Moteur d'image et modèle par moteur (image.json, poussé par la barre et
    // les Réglages) : le Studio, la Planche ou l'Aventure packagés lisent ces
    // clés dès leur premier rendu, avant l'événement `settings` de l'hôte.
    let img = crate::bonsai::read_image_config(app);
    put("imageProvider", img.provider);
    put("imageBonsaiModel", img.bonsai_model);
    put("imageOllamaModel", img.ollama_model);
    put("imageOpenaiModel", img.openai_model);
    put("imagePlaygroundStyle", img.playground_style);
    serde_json::Value::Object(out).to_string()
}

/// Insère les ponts au tout début du `<head>`, ou à défaut en tête de document.
fn inject(html: &str, manifest: &str, settings: &str) -> String {
    let head = format!(
        "<script>window.__LUMEN_APP__={manifest};window.__LUMEN_SETTINGS__={settings};</script>\n<script>{TAURI_SHIM}</script>\n<script>{APPKIT_GUEST}</script>\n"
    );
    let lower = html.to_lowercase();
    if let Some(i) = lower.find("<head>") {
        let at = i + "<head>".len();
        return format!("{}\n{head}{}", &html[..at], &html[at..]);
    }
    // Une page sans <head> reste une page : on préfixe, plutôt que de refuser de
    // servir l'app parce qu'elle n'a pas la forme attendue.
    format!("{head}{html}")
}

/// Retrouve l'app d'une requête qui a PERDU son identifiant.
///
/// Sur Windows l'identifiant est un segment de chemin, pas un hôte : une page
/// qui référence `/lib/theme-init.js` en absolu demande
/// `http://lumenapp.localhost/lib/theme-init.js` — `lib` n'est pas une app.
/// Le `Referer` (`http://lumenapp.localhost/<id>/…`) dit d'où vient la demande ;
/// on ramène alors la requête à `<id>/lib/theme-init.js`. Sur macOS/Linux
/// l'hôte porte l'identifiant et un chemin absolu reste dans l'app.
fn from_referer(referer: &str, id: &str, path: &str) -> Option<(String, String)> {
    let (ref_id, _) = split_target(referer)?;
    if ref_id == id {
        return None;
    }
    let full = if path.is_empty() { id.to_string() } else { format!("{id}/{path}") };
    Some((ref_id, full))
}

/// Répond à une requête `lumenapp://`.
pub fn handle(app: &tauri::AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri().to_string();
    let Some((mut id, mut path)) = split_target(&uri) else {
        return not_found("URL d'application invalide");
    };

    let Ok(base) = crate::paths::shared_data_dir(app.path()) else {
        return not_found("dossier de données introuvable");
    };
    let apps = base.join("apps");
    if (uri.contains("lumenapp.localhost/") || uri.starts_with("lumenapp://localhost/")) && !apps.join(&id).is_dir() {
        let referer = request
            .headers()
            .get("referer")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if let Some((rid, rpath)) = from_referer(referer, &id, &path) {
            id = rid;
            path = rpath;
        }
    }
    if path.is_empty() {
        path = "index.html".into();
    }
    let root = apps.join(&id);
    // `canonicalize` résout les liens symboliques : c'est ce qui empêche une
    // archive d'avoir posé un lien vers ailleurs sur le disque.
    let (Ok(root_real), Ok(target_real)) = (root.canonicalize(), root.join(&path).canonicalize()) else {
        return not_found("fichier introuvable");
    };
    if !target_real.starts_with(&root_real) {
        return not_found("chemin hors de l'application");
    }

    let Ok(bytes) = std::fs::read(&target_real) else {
        return not_found("fichier illisible");
    };

    let mime = mime_of(&path);
    let body = if mime.starts_with("text/html") {
        let manifest = std::fs::read_to_string(root_real.join("manifest.json"))
            .unwrap_or_else(|_| "{}".to_string());
        let html = String::from_utf8_lossy(&bytes).to_string();
        inject(&html, manifest.trim(), &settings_snapshot(&app)).into_bytes()
    } else {
        bytes
    };

    Response::builder()
        .status(200)
        .header("content-type", mime)
        // Le bureau charge ces pages en iframe : sans en-tête permissif, la
        // webview refuse. L'isolement ne vient pas de là mais de l'origine.
        .header("access-control-allow-origin", "*")
        .header("cache-control", "no-cache")
        .body(body)
        .unwrap_or_else(|_| not_found("réponse impossible"))
}

#[cfg(test)]
mod tests {
    use super::{inject, split_target};

    #[test]
    fn retrouve_l_app_par_le_referer_sous_windows() {
        use super::from_referer;
        assert_eq!(
            from_referer("http://lumenapp.localhost/mindmap/mindmap.html", "lib", "theme-init.js"),
            Some(("mindmap".into(), "lib/theme-init.js".into()))
        );
        // Même app : rien à corriger.
        assert_eq!(from_referer("http://lumenapp.localhost/mindmap/mindmap.html", "mindmap", "a.js"), None);
        // Pas de referer exploitable.
        assert_eq!(from_referer("", "lib", "x.js"), None);
    }

    #[test]
    fn decoupe_les_deux_formes_d_url() {
        assert_eq!(split_target("lumenapp://muse/index.html"), Some(("muse".into(), "index.html".into())));
        assert_eq!(split_target("http://lumenapp.localhost/muse/a/b.js"), Some(("muse".into(), "a/b.js".into())));
        // Forme retraduite par wry sous Windows : l'hôte est « localhost ».
        assert_eq!(split_target("lumenapp://localhost/muse/a/b.js"), Some(("muse".into(), "a/b.js".into())));
        assert_eq!(split_target("lumenapp://localhost/lib/theme-init.js"), Some(("lib".into(), "theme-init.js".into())));
        // Une URL sans chemin doit rendre un chemin vide, pas échouer : c'est le
        // cas normal de `lumenapp://muse`.
        assert_eq!(split_target("lumenapp://muse"), Some(("muse".into(), String::new())));
        assert_eq!(split_target("https://exemple.org/x"), None);
    }

    #[test]
    fn les_ponts_passent_avant_les_scripts_de_l_app() {
        let out = inject("<html><head><script src=\"app.js\"></script></head></html>", "{}", "{}");
        assert!(out.find("__LUMEN_APP__").unwrap() < out.find("app.js").unwrap());
    }
}
