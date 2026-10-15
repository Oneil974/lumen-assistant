//! Connecteurs **distants** : API REST, WebDAV, Nextcloud, S3/MinIO,
//! SharePoint, OneDrive, Google Drive, GitHub.
//!
//! Ils partagent une propriété simple et vérifiable en lisant ce fichier :
//! **aucune requête d'écriture n'y est construite**. Les seules méthodes HTTP
//! émises sont `GET` et, pour WebDAV, `PROPFIND` (qui est une lecture). Il n'y a
//! nulle part de `PUT`, `POST`, `PATCH`, `DELETE`, `MKCOL` ou `COPY` : même un
//! appelant malveillant ne dispose pas du verbe.
//!
//! Les identifiants viennent de `secrets` et ne repartent jamais vers
//! l'interface ni vers le modèle ; ils sont posés en en-tête, jamais en
//! paramètre d'URL (une URL se retrouve dans les journaux du serveur d'en face).

use super::{safe_path, DataSource, Dataset, ObjectEntry, Page, ReadOpts, MAX_OBJECT_BYTES};
use base64::Engine;
use serde_json::{json, Value};
use std::time::Duration;

const AGENT: &str = "Lumen-DataSources/1.0";

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(AGENT)
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())
}

/// Applique l'authentification déclarée sur la source. Quatre modes couvrent
/// tout ce que ces services demandent en pratique.
fn authorize(src: &DataSource, req: reqwest::blocking::RequestBuilder) -> reqwest::blocking::RequestBuilder {
    let token = src.secret("token");
    match src.cfg("auth").as_str() {
        "basic" => req.basic_auth(src.cfg("user"), Some(src.secret("password"))),
        "header" => {
            let name = if src.cfg("header").is_empty() { "Authorization".to_string() } else { src.cfg("header") };
            if token.is_empty() { req } else { req.header(name, token) }
        }
        "none" => req,
        // Par défaut : porteur (bearer), le cas le plus courant.
        _ => {
            if token.is_empty() { req } else { req.bearer_auth(token) }
        }
    }
}

fn text_of(resp: reqwest::blocking::Response) -> Result<String, String> {
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {status} — {}", body.chars().take(300).collect::<String>()));
    }
    Ok(body)
}

fn json_of(resp: reqwest::blocking::Response) -> Result<Value, String> {
    let body = text_of(resp)?;
    serde_json::from_str(&body).map_err(|e| format!("Réponse non JSON : {e}"))
}

fn get_json(src: &DataSource, url: &str) -> Result<Value, String> {
    let req = authorize(src, client()?.get(url));
    json_of(req.send().map_err(|e| e.to_string())?)
}

fn base(src: &DataSource) -> Result<String, String> {
    let b = src.cfg("base_url").trim_end_matches('/').to_string();
    if b.is_empty() {
        return Err("Renseignez l'URL de base de la source.".into());
    }
    if !(b.starts_with("https://") || b.starts_with("http://")) {
        return Err("L'URL de base doit commencer par http:// ou https://".into());
    }
    Ok(b)
}

/// Enveloppe standard d'un objet lu. Le texte reste du texte (lisible par un
/// modèle sans détour) ; le binaire part en base64, borné à 16 Mio.
pub fn payload(path: &str, mime: &str, bytes: Vec<u8>) -> Value {
    let size = bytes.len();
    if size > MAX_OBJECT_BYTES {
        return json!({ "path": path, "mime": mime, "size": size, "encoding": "none",
                       "error": "Objet trop volumineux ; réduisez la sélection." });
    }
    match String::from_utf8(bytes.clone()) {
        Ok(text) => json!({ "path": path, "mime": mime, "size": size, "encoding": "text", "content": text }),
        Err(_) => json!({
            "path": path, "mime": mime, "size": size, "encoding": "base64",
            "content": base64::engine::general_purpose::STANDARD.encode(&bytes),
        }),
    }
}

fn fetch_bytes(src: &DataSource, url: &str) -> Result<Vec<u8>, String> {
    let resp = authorize(src, client()?.get(url)).send().map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    Ok(bytes.to_vec())
}

/// Suit un chemin pointé (`data.items`) dans une réponse JSON.
fn dig<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = value;
    for seg in path.split('.').filter(|s| !s.is_empty()) {
        cur = match seg.parse::<usize>() {
            Ok(i) => cur.get(i)?,
            Err(_) => cur.get(seg)?,
        };
    }
    Some(cur)
}

/// Ramène une réponse quelconque à une liste d'objets : soit le tableau pointé
/// par `rows_path`, soit le premier tableau trouvé, soit l'objet seul.
fn rows_of(value: &Value, rows_path: &str) -> Vec<Value> {
    if !rows_path.is_empty() {
        if let Some(Value::Array(a)) = dig(value, rows_path) {
            return a.clone();
        }
    }
    match value {
        Value::Array(a) => a.clone(),
        Value::Object(map) => map
            .values()
            .find_map(|v| v.as_array().cloned())
            .unwrap_or_else(|| vec![value.clone()]),
        other => vec![other.clone()],
    }
}

// ===================== REST =====================
//
// Les points d'entrée sont **déclarés par l'utilisateur** dans la configuration
// (`endpoints`, un tableau JSON `[{ "name", "path", "rowsPath" }]`). Le modèle
// choisit parmi eux ; il ne compose pas d'URL. C'est ce qui empêche une source
// REST de devenir un proxy HTTP généraliste.

fn endpoints(src: &DataSource) -> Vec<Value> {
    serde_json::from_str::<Value>(&src.cfg("endpoints"))
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

fn endpoint(src: &DataSource, name: &str) -> Result<(String, String), String> {
    endpoints(src)
        .iter()
        .find(|e| e.get("name").and_then(|n| n.as_str()) == Some(name))
        .map(|e| {
            (
                e.get("path").and_then(|p| p.as_str()).unwrap_or_default().to_string(),
                e.get("rowsPath").and_then(|p| p.as_str()).unwrap_or_default().to_string(),
            )
        })
        .ok_or_else(|| format!("Point d'entrée « {name} » non déclaré sur cette source."))
}

pub fn rest_ping(src: &DataSource) -> Result<String, String> {
    let b = base(src)?;
    let probe = endpoints(src)
        .first()
        .and_then(|e| e.get("path").and_then(|p| p.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();
    let url = format!("{b}/{}", probe.trim_start_matches('/'));
    let resp = authorize(src, client()?.get(&url)).send().map_err(|e| e.to_string())?;
    Ok(format!("HTTP {} sur {url}", resp.status()))
}

pub fn rest_datasets(src: &DataSource) -> Result<Vec<Dataset>, String> {
    let list = endpoints(src);
    if list.is_empty() {
        return Err("Déclarez au moins un point d'entrée (nom + chemin) sur cette source REST.".into());
    }
    Ok(list
        .iter()
        .map(|e| Dataset {
            name: e.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
            schema: String::new(),
            rows: None,
            note: e.get("path").and_then(|p| p.as_str()).unwrap_or_default().to_string(),
        })
        .collect())
}

pub fn rest_schema(src: &DataSource, dataset: &str) -> Result<Value, String> {
    let page = rest_rows(src, dataset, &ReadOpts { limit: 5, ..Default::default() })?;
    let cols: Vec<Value> = page.columns.iter().map(|c| json!({ "name": c, "type": "unknown", "inferred": true })).collect();
    Ok(json!({ "dataset": dataset, "columns": cols }))
}

pub fn rest_rows(src: &DataSource, dataset: &str, opts: &ReadOpts) -> Result<Page, String> {
    let (path, rows_path) = endpoint(src, dataset)?;
    let b = base(src)?;
    let limit = opts.bounded_limit();
    let mut url = format!("{b}/{}", path.trim_start_matches('/'));
    // Les filtres deviennent des paramètres de requête : c'est la convention de
    // fait des API REST, et cela reste une lecture.
    let mut params: Vec<(String, String)> = opts.filters.clone();
    if !src.cfg("limit_param").is_empty() {
        params.push((src.cfg("limit_param"), limit.to_string()));
    }
    if !src.cfg("offset_param").is_empty() && opts.offset > 0 {
        params.push((src.cfg("offset_param"), opts.offset.to_string()));
    }
    if !params.is_empty() {
        let qs = params
            .iter()
            .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v)))
            .collect::<Vec<_>>()
            .join("&");
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str(&qs);
    }
    let body = get_json(src, &url)?;
    let mut objs = rows_of(&body, &rows_path);
    if objs.len() as i64 > limit {
        objs.truncate(limit as usize);
    }
    Ok(super::sql::page_from_objects(objs, limit, opts.offset.max(0)))
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "%20".to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

// ===================== WebDAV / Nextcloud =====================

/// Racine WebDAV. Nextcloud impose `/remote.php/dav/files/<user>` : on le
/// construit pour l'utilisateur plutôt que de lui demander de le connaître.
fn dav_root(src: &DataSource) -> Result<String, String> {
    let b = base(src)?;
    if src.kind == "nextcloud" {
        let user = src.cfg("user");
        if user.is_empty() {
            return Err("Renseignez l'utilisateur Nextcloud.".into());
        }
        return Ok(format!("{b}/remote.php/dav/files/{}", urlencode(&user)));
    }
    Ok(b)
}

/// Extrait les `<response>` d'un multistatus WebDAV. Un analyseur minimal
/// suffit : PROPFIND renvoie une structure plate et très stable, et cela évite
/// d'embarquer un parseur XML pour quatre balises.
fn parse_multistatus(xml: &str, root_path: &str) -> Vec<ObjectEntry> {
    fn tag<'a>(block: &'a str, name: &str) -> Option<&'a str> {
        let open_a = format!("<{name}>");
        let open_b = format!(":{name}>");
        let start = block.find(&open_a).map(|i| i + open_a.len()).or_else(|| {
            block.find(&open_b).map(|i| i + open_b.len())
        })?;
        let rest = &block[start..];
        let end = rest.find("</")?;
        Some(rest[..end].trim())
    }
    let mut out = Vec::new();
    for block in xml.split("<").collect::<Vec<_>>().join("<").split("response>").skip(1) {
        let Some(href) = tag(block, "href") else { continue };
        let href = href.trim();
        if href.is_empty() {
            continue;
        }
        let decoded = href.replace("%20", " ");
        let rel = decoded
            .split(root_path)
            .last()
            .unwrap_or(&decoded)
            .trim_start_matches('/')
            .trim_end_matches('/')
            .to_string();
        if rel.is_empty() {
            continue; // le dossier interrogé lui-même
        }
        let dir = block.contains("collection");
        out.push(ObjectEntry {
            name: rel.rsplit('/').next().unwrap_or(&rel).to_string(),
            path: rel,
            dir,
            size: tag(block, "getcontentlength").and_then(|s| s.parse().ok()),
            modified: tag(block, "getlastmodified").unwrap_or_default().to_string(),
            mime: tag(block, "getcontenttype").unwrap_or_default().to_string(),
        });
    }
    out.sort_by(|a, b| (b.dir, a.name.to_lowercase()).cmp(&(a.dir, b.name.to_lowercase())));
    out.dedup_by(|a, b| a.path == b.path);
    out
}

pub fn webdav_list(src: &DataSource, path: &str) -> Result<Vec<ObjectEntry>, String> {
    let root = dav_root(src)?;
    let rel = safe_path(path)?;
    let url = if rel.is_empty() { root.clone() } else { format!("{root}/{}", encode_path(&rel)) };
    // PROPFIND est la lecture d'un dossier WebDAV — l'équivalent d'un GET.
    let req = authorize(
        src,
        client()?
            .request(reqwest::Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?, &url)
            .header("Depth", "1"),
    );
    let xml = text_of(req.send().map_err(|e| e.to_string())?)?;
    let base_path = url_path_of(&root);
    Ok(parse_multistatus(&xml, &base_path))
}

fn url_path_of(url: &str) -> String {
    url.splitn(4, '/').nth(3).map(|p| format!("/{p}")).unwrap_or_else(|| "/".into())
}

fn encode_path(rel: &str) -> String {
    rel.split('/').map(urlencode).collect::<Vec<_>>().join("/")
}

pub fn webdav_get(src: &DataSource, path: &str) -> Result<Value, String> {
    let rel = safe_path(path)?;
    let url = format!("{}/{}", dav_root(src)?, encode_path(&rel));
    let bytes = fetch_bytes(src, &url)?;
    Ok(payload(&rel, "", bytes))
}

// ===================== S3 / MinIO =====================

/// Signature AWS SigV4 pour un `GET`. Écrite ici plutôt qu'importée : elle tient
/// en trente lignes, n'a besoin que de HMAC-SHA256 (déjà présent pour le
/// compagnon), et le connecteur ne signe **que** des requêtes de lecture.
fn s3_signed_get(src: &DataSource, path: &str, query: &str) -> Result<Vec<u8>, String> {
    use hmac::{Hmac, Mac};
    use sha2::{Digest, Sha256};
    type H = Hmac<Sha256>;

    let endpoint = base(src)?;
    let region = if src.cfg("region").is_empty() { "us-east-1".to_string() } else { src.cfg("region") };
    let key = src.secret("access_key");
    let secret = src.secret("secret_key");
    if key.is_empty() || secret.is_empty() {
        return Err("Renseignez la clé d'accès et la clé secrète S3.".into());
    }
    let host = endpoint.split("://").nth(1).unwrap_or_default().trim_end_matches('/').to_string();
    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    let empty_hash = format!("{:x}", Sha256::digest(b""));

    let canonical = format!(
        "GET\n{path}\n{query}\nhost:{host}\nx-amz-content-sha256:{empty_hash}\nx-amz-date:{amz_date}\n\nhost;x-amz-content-sha256;x-amz-date\n{empty_hash}"
    );
    let scope = format!("{date}/{region}/s3/aws4_request");
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{:x}",
        Sha256::digest(canonical.as_bytes())
    );
    let mut mac = H::new_from_slice(format!("AWS4{secret}").as_bytes()).map_err(|e| e.to_string())?;
    for step in [date.as_str(), region.as_str(), "s3", "aws4_request"] {
        mac.update(step.as_bytes());
        let out = mac.finalize().into_bytes();
        mac = H::new_from_slice(&out).map_err(|e| e.to_string())?;
    }
    mac.update(to_sign.as_bytes());
    let signature = format!("{:x}", mac.finalize().into_bytes());
    let auth = format!(
        "AWS4-HMAC-SHA256 Credential={key}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={signature}"
    );

    let url = if query.is_empty() { format!("{endpoint}{path}") } else { format!("{endpoint}{path}?{query}") };
    let resp = client()?
        .get(&url)
        .header("Authorization", auth)
        .header("x-amz-date", amz_date)
        .header("x-amz-content-sha256", empty_hash)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let bytes = resp.bytes().map_err(|e| e.to_string())?.to_vec();
    if !status.is_success() {
        return Err(format!("S3 HTTP {status} — {}", String::from_utf8_lossy(&bytes).chars().take(300).collect::<String>()));
    }
    Ok(bytes)
}

pub fn s3_list(src: &DataSource, path: &str) -> Result<Vec<ObjectEntry>, String> {
    let bucket = src.cfg("bucket");
    if bucket.is_empty() {
        return Err("Renseignez le bucket.".into());
    }
    let prefix = safe_path(path)?;
    let query = format!("list-type=2&max-keys=1000&delimiter=%2F&prefix={}", urlencode(&prefix));
    let xml = String::from_utf8_lossy(&s3_signed_get(src, &format!("/{bucket}"), &query)?).to_string();

    let between = |block: &str, tag: &str| -> Option<String> {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        let start = block.find(&open)? + open.len();
        let end = block[start..].find(&close)? + start;
        Some(block[start..end].to_string())
    };
    let mut out = Vec::new();
    for block in xml.split("<CommonPrefixes>").skip(1) {
        if let Some(p) = between(block, "Prefix") {
            let trimmed = p.trim_end_matches('/').to_string();
            out.push(ObjectEntry {
                name: trimmed.rsplit('/').next().unwrap_or(&trimmed).to_string(),
                path: p,
                dir: true,
                size: None,
                modified: String::new(),
                mime: String::new(),
            });
        }
    }
    for block in xml.split("<Contents>").skip(1) {
        let Some(k) = between(block, "Key") else { continue };
        if k.ends_with('/') {
            continue;
        }
        out.push(ObjectEntry {
            name: k.rsplit('/').next().unwrap_or(&k).to_string(),
            path: k,
            dir: false,
            size: between(block, "Size").and_then(|s| s.parse().ok()),
            modified: between(block, "LastModified").unwrap_or_default(),
            mime: String::new(),
        });
    }
    Ok(out)
}

pub fn s3_get(src: &DataSource, path: &str) -> Result<Value, String> {
    let bucket = src.cfg("bucket");
    let key = safe_path(path)?;
    let bytes = s3_signed_get(src, &format!("/{bucket}/{}", encode_path(&key)), "")?;
    Ok(payload(&key, "", bytes))
}

// ===================== Microsoft Graph : SharePoint & OneDrive =====================

/// Racine Graph du lecteur visé. SharePoint passe par un site (`site_id`),
/// OneDrive par le lecteur de l'utilisateur.
fn graph_drive(src: &DataSource) -> Result<String, String> {
    let api = "https://graph.microsoft.com/v1.0";
    if src.kind == "sharepoint" {
        let site = src.cfg("site_id");
        if site.is_empty() {
            return Err("Renseignez l'identifiant du site SharePoint (site_id).".into());
        }
        let drive = src.cfg("drive_id");
        return Ok(if drive.is_empty() {
            format!("{api}/sites/{site}/drive")
        } else {
            format!("{api}/sites/{site}/drives/{drive}")
        });
    }
    let user = src.cfg("user_id");
    Ok(if user.is_empty() { format!("{api}/me/drive") } else { format!("{api}/users/{user}/drive") })
}

fn graph_entries(body: &Value) -> Vec<ObjectEntry> {
    body.get("value")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|it| {
                    let name = it.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string();
                    let parent = it
                        .get("parentReference")
                        .and_then(|p| p.get("path"))
                        .and_then(|p| p.as_str())
                        .unwrap_or_default();
                    let prefix = parent.split("root:").nth(1).unwrap_or("").trim_start_matches('/');
                    let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
                    ObjectEntry {
                        name,
                        path,
                        dir: it.get("folder").is_some(),
                        size: it.get("size").and_then(|s| s.as_u64()),
                        modified: it
                            .get("lastModifiedDateTime")
                            .and_then(|d| d.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        mime: it
                            .get("file")
                            .and_then(|f| f.get("mimeType"))
                            .and_then(|m| m.as_str())
                            .unwrap_or_default()
                            .to_string(),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn graph_list(src: &DataSource, path: &str) -> Result<Vec<ObjectEntry>, String> {
    let rel = safe_path(path)?;
    let drive = graph_drive(src)?;
    let url = if rel.is_empty() {
        format!("{drive}/root/children")
    } else {
        format!("{drive}/root:/{}:/children", encode_path(&rel))
    };
    Ok(graph_entries(&get_json(src, &url)?))
}

pub fn graph_get(src: &DataSource, path: &str) -> Result<Value, String> {
    let rel = safe_path(path)?;
    let url = format!("{}/root:/{}:/content", graph_drive(src)?, encode_path(&rel));
    Ok(payload(&rel, "", fetch_bytes(src, &url)?))
}

// ===================== Google Drive =====================

pub fn gdrive_list(src: &DataSource, path: &str) -> Result<Vec<ObjectEntry>, String> {
    // Drive n'a pas de chemins : `path` est un identifiant de dossier, vide pour
    // la racine (ou le dossier `folder_id` de la configuration).
    let folder = if path.trim().is_empty() {
        let cfg = src.cfg("folder_id");
        if cfg.is_empty() { "root".to_string() } else { cfg }
    } else {
        path.trim().to_string()
    };
    let q = urlencode(&format!("'{folder}' in parents and trashed = false"));
    let url = format!(
        "https://www.googleapis.com/drive/v3/files?q={q}&pageSize=200&fields={}",
        urlencode("files(id,name,mimeType,size,modifiedTime)")
    );
    let body = get_json(src, &url)?;
    Ok(body
        .get("files")
        .and_then(|f| f.as_array())
        .map(|items| {
            items
                .iter()
                .map(|it| {
                    let mime = it.get("mimeType").and_then(|m| m.as_str()).unwrap_or_default().to_string();
                    ObjectEntry {
                        name: it.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
                        path: it.get("id").and_then(|i| i.as_str()).unwrap_or_default().to_string(),
                        dir: mime == "application/vnd.google-apps.folder",
                        size: it.get("size").and_then(|s| s.as_str()).and_then(|s| s.parse().ok()),
                        modified: it.get("modifiedTime").and_then(|d| d.as_str()).unwrap_or_default().to_string(),
                        mime,
                    }
                })
                .collect()
        })
        .unwrap_or_default())
}

pub fn gdrive_get(src: &DataSource, path: &str) -> Result<Value, String> {
    let id = path.trim();
    if id.is_empty() {
        return Err("Indiquez l'identifiant du fichier Drive.".into());
    }
    let meta = get_json(
        src,
        &format!("https://www.googleapis.com/drive/v3/files/{id}?fields={}", urlencode("name,mimeType")),
    )?;
    let mime = meta.get("mimeType").and_then(|m| m.as_str()).unwrap_or_default();
    let name = meta.get("name").and_then(|n| n.as_str()).unwrap_or(id).to_string();
    // Les documents natifs Google n'ont pas de contenu binaire : on les exporte
    // en texte, ce qui est exactement ce dont un modèle a besoin.
    let url = if mime.starts_with("application/vnd.google-apps") {
        let target = match mime {
            "application/vnd.google-apps.spreadsheet" => "text/csv",
            _ => "text/plain",
        };
        format!("https://www.googleapis.com/drive/v3/files/{id}/export?mimeType={}", urlencode(target))
    } else {
        format!("https://www.googleapis.com/drive/v3/files/{id}?alt=media")
    };
    Ok(payload(&name, mime, fetch_bytes(src, &url)?))
}

// ===================== GitHub =====================

fn github_repo(src: &DataSource) -> Result<(String, String), String> {
    let owner = src.cfg("owner");
    let repo = src.cfg("repo");
    if owner.is_empty() || repo.is_empty() {
        return Err("Renseignez le propriétaire et le dépôt.".into());
    }
    Ok((owner, repo))
}

fn github_api(src: &DataSource) -> String {
    let b = src.cfg("base_url");
    if b.is_empty() { "https://api.github.com".into() } else { b.trim_end_matches('/').to_string() }
}

pub fn github_list(src: &DataSource, path: &str) -> Result<Vec<ObjectEntry>, String> {
    let (owner, repo) = github_repo(src)?;
    let rel = safe_path(path)?;
    let mut url = format!("{}/repos/{owner}/{repo}/contents/{}", github_api(src), encode_path(&rel));
    if !src.cfg("ref").is_empty() {
        url.push_str(&format!("?ref={}", urlencode(&src.cfg("ref"))));
    }
    let body = get_json(src, &url)?;
    let items = match &body {
        Value::Array(a) => a.clone(),
        other => vec![other.clone()],
    };
    Ok(items
        .iter()
        .map(|it| ObjectEntry {
            name: it.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
            path: it.get("path").and_then(|p| p.as_str()).unwrap_or_default().to_string(),
            dir: it.get("type").and_then(|t| t.as_str()) == Some("dir"),
            size: it.get("size").and_then(|s| s.as_u64()),
            modified: String::new(),
            mime: it.get("type").and_then(|t| t.as_str()).unwrap_or_default().to_string(),
        })
        .collect())
}

pub fn github_get(src: &DataSource, path: &str) -> Result<Value, String> {
    let (owner, repo) = github_repo(src)?;
    let rel = safe_path(path)?;
    let mut url = format!("{}/repos/{owner}/{repo}/contents/{}", github_api(src), encode_path(&rel));
    if !src.cfg("ref").is_empty() {
        url.push_str(&format!("?ref={}", urlencode(&src.cfg("ref"))));
    }
    let req = authorize(src, client()?.get(&url).header("Accept", "application/vnd.github.raw"));
    let resp = req.send().map_err(|e| e.to_string())?;
    let status = resp.status();
    let bytes = resp.bytes().map_err(|e| e.to_string())?.to_vec();
    if !status.is_success() {
        return Err(format!("GitHub HTTP {status}"));
    }
    Ok(payload(&rel, "", bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_are_found_wherever_the_api_put_them() {
        let body = json!({ "data": { "items": [{ "a": 1 }] } });
        assert_eq!(rows_of(&body, "data.items").len(), 1);
        assert_eq!(rows_of(&body, "").len(), 1); // premier tableau trouvé
        assert_eq!(rows_of(&json!([1, 2, 3]), "").len(), 3);
    }

    #[test]
    fn multistatus_yields_children_without_the_folder_itself() {
        let xml = r#"<d:multistatus xmlns:d="DAV:">
          <d:response><d:href>/dav/docs/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
          <d:response><d:href>/dav/docs/note.md</d:href><d:propstat><d:prop><d:getcontentlength>12</d:getcontentlength></d:prop></d:propstat></d:response>
        </d:multistatus>"#;
        let out = parse_multistatus(xml, "/dav/docs");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "note.md");
        assert_eq!(out[0].size, Some(12));
    }

    #[test]
    fn payload_keeps_text_readable_and_encodes_binary() {
        let t = payload("a.txt", "", b"bonjour".to_vec());
        assert_eq!(t["encoding"], "text");
        let b = payload("a.bin", "", vec![0xff, 0xfe, 0x00]);
        assert_eq!(b["encoding"], "base64");
    }
}
