//! Pont vers Lumen : les blocs « retour » (notification, widget, progression,
//! mémoire partagée) parlent au serveur loopback de Lumen (127.0.0.1:8765), qui
//! expose déjà `/notify`, `/run/widget`, `/run/progress` et `/mem/*`.
//!
//! Quand un workflow est exécuté DANS Lumen (backend d'actions), ce serveur est
//! déjà en écoute, donc ces blocs atteignent directement l'UI. En CLI/standalone
//! (Lumen absent), les appels sont best-effort : ils échouent proprement et
//! l'appelant peut retomber sur un comportement système.

use std::time::Duration;

/// Base URL du serveur loopback de Lumen. Surchargeable via `LUMEN_URL`.
pub fn base_url() -> String {
    std::env::var("LUMEN_URL").unwrap_or_else(|_| "http://127.0.0.1:8765".to_string())
}

/// Identifiant du run courant : relie widgets et progression à la bonne bulle de
/// conversation. Fourni par Lumen via `FLUXO_RUN_ID` ; « fluxo » par défaut hors
/// contexte (run autonome).
pub fn run_id() -> String {
    std::env::var("FLUXO_RUN_ID").unwrap_or_else(|_| "fluxo".to_string())
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

fn url(path: &str) -> String {
    format!("{}{}", base_url().trim_end_matches('/'), path)
}

/// Message d'erreur d'une réponse HTTP en échec.
///
/// Un 401 ou un 403 sur la boucle locale ne peut PAS venir de Lumen : ses
/// routes loopback n'ont aucune authentification, par construction. Recevoir un
/// refus d'authentification signifie donc qu'un AUTRE programme occupe le port
/// et répond à sa place. Écrire « Lumen a refusé la requête » dans ce cas
/// désigne le mauvais coupable et envoie chercher la panne du mauvais côté.
fn refused(url: &str, err: reqwest::Error) -> anyhow::Error {
    let status = err.status();
    if matches!(
        status,
        Some(reqwest::StatusCode::UNAUTHORIZED) | Some(reqwest::StatusCode::FORBIDDEN)
    ) {
        return anyhow::anyhow!(
            "Un autre programme occupe le port de Lumen et a refusé la requête ({url}, \
             {status}). Les routes locales de Lumen ne demandent jamais d'authentification : \
             fermez le programme qui écoute sur ce port, puis relancez Lumen.",
            status = status.map(|s| s.as_u16()).unwrap_or(0)
        );
    }
    anyhow::anyhow!("Lumen a refusé la requête : {err}")
}

/// POST JSON vers une route de Lumen ; renvoie le corps de réponse en texte.
/// La feature `json` de reqwest n'est pas activée → on sérialise nous-mêmes.
pub fn post_json(path: &str, body: serde_json::Value) -> anyhow::Result<String> {
    let u = url(path);
    let resp = client()
        .post(&u)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body)?)
        .send()
        .map_err(|e| anyhow::anyhow!("Lumen injoignable ({u}) : {e}"))?;
    body_or_refusal(&u, resp)
}

/// Le corps d'une réponse d'erreur de Lumen EST le message (« fichier
/// introuvable, fichiers proches : … ») : le rendre au bloc, et donc au modèle,
/// plutôt qu'un « 400 Bad Request » qui ne dit rien.
fn body_or_refusal(u: &str, resp: reqwest::blocking::Response) -> anyhow::Result<String> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp.text().unwrap_or_default());
    }
    if let Err(e) = resp.error_for_status_ref() {
        if matches!(status, reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) {
            return Err(refused(u, e));
        }
    }
    let text = resp.text().unwrap_or_default();
    let text = text.trim();
    Err(if text.is_empty() {
        anyhow::anyhow!("Lumen a refusé la requête ({status})")
    } else {
        anyhow::anyhow!("{text}")
    })
}

/// POST JSON avec un délai d'attente personnalisé. Indispensable pour les blocs
/// longs (génération d'image Bonsai/OpenAI) qui dépassent largement les 5 s du
/// client par défaut.
pub fn post_json_timeout(
    path: &str,
    body: serde_json::Value,
    timeout_secs: u64,
) -> anyhow::Result<String> {
    let u = url(path);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new());
    let resp = client
        .post(&u)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body)?)
        .send()
        .map_err(|e| anyhow::anyhow!("Lumen injoignable ({u}) : {e}"))?;
    body_or_refusal(&u, resp)
}

/// PUT JSON (écriture mémoire partagée) ; renvoie le corps de réponse.
pub fn put_json(path: &str, body: serde_json::Value) -> anyhow::Result<String> {
    let u = url(path);
    let resp = client()
        .put(&u)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body)?)
        .send()
        .map_err(|e| anyhow::anyhow!("Lumen injoignable ({u}) : {e}"))?
        .error_for_status()
        .map_err(|e| refused(&u, e))?;
    Ok(resp.text().unwrap_or_default())
}

/// GET texte depuis Lumen. Un 404 renvoie une chaîne vide (entrée absente).
pub fn get_text(path: &str) -> anyhow::Result<String> {
    let u = url(path);
    let resp = client()
        .get(&u)
        .send()
        .map_err(|e| anyhow::anyhow!("Lumen injoignable ({u}) : {e}"))?;
    if resp.status().as_u16() == 404 {
        return Ok(String::new());
    }
    let resp = resp
        .error_for_status()
        .map_err(|e| refused(&u, e))?;
    Ok(resp.text().unwrap_or_default())
}

/// Tente une notification via Lumen (`POST /notify`). Renvoie `true` si livrée,
/// `false` si Lumen est injoignable — l'appelant peut alors retomber sur la
/// notification système.
pub fn try_notify(kind: &str, title: &str, body: &str) -> bool {
    post_json(
        "/notify",
        serde_json::json!({ "kind": kind, "title": title, "body": body }),
    )
    .is_ok()
}

/// Publie une entrée dans le **centre de notifications** de Lumen (la cloche),
/// via `POST /notify/center`. Contrairement à `try_notify` (bulle flottante
/// éphémère), l'entrée est persistée dans l'historique et compte comme non-lue.
pub fn try_notify_center(title: &str, body: &str, success: bool) -> bool {
    post_json(
        "/notify/center",
        serde_json::json!({ "title": title, "body": body, "success": success }),
    )
    .is_ok()
}
