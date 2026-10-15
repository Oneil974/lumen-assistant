//! Rendu JavaScript d'une page web dans une WebView **cachée**.
//!
//! `web_fetch` récupère le HTML livré par le serveur. Sur une application rendue
//! côté client, ce HTML ne contient qu'un `<div id="app"></div>` : le modèle
//! reçoit une page vide et conclut, à tort, que le sujet n'existe pas. OpenClaw
//! résout cela avec Playwright et son Chromium ; ici on réutilise la WebView du
//! système (WKWebView, WebView2, WebKitGTK) que Tauri embarque DÉJÀ — aucune
//! dépendance ni centaine de mégaoctets supplémentaires dans le bundle.
//!
//! ## Comment le HTML revient
//!
//! La difficulté est le canal de retour : `eval` ne rend pas de valeur, et
//! donner l'IPC Tauri à une page distante l'autoriserait à appeler les commandes
//! de Lumen (fichiers, domotique, modèles…) — inacceptable pour une page
//! inconnue. On ouvre donc, le temps du rendu seulement, un serveur HTTP
//! ÉPHÉMÈRE sur 127.0.0.1 avec un port choisi par le système et un jeton
//! aléatoire, et le script injecté lui poste le DOM. Conséquences :
//!
//!  - la fenêtre de rendu n'a AUCUNE capability Tauri (son label n'est dans
//!    aucun fichier de `capabilities/`) : l'IPC lui est fermé ;
//!  - la surface réseau n'existe que pendant le rendu, et n'accepte qu'un seul
//!    message, porteur du bon jeton ;
//!  - au pire, une page hostile renvoie un faux DOM… de sa propre page, qu'elle
//!    contrôle de toute façon. Aucune élévation de privilège n'est possible.
//!
//! Le rendu reste un BONUS : si la page bloque la requête par sa CSP, ou dépasse
//! le délai, l'appelant garde le résultat de `web_fetch`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Délai maximal accordé à une page pour se charger ET se rendre.
const RENDER_TIMEOUT: Duration = Duration::from_secs(20);
/// Temps laissé au script de la page après `load` (rendu, hydratation, XHR).
const SETTLE_MS: u32 = 1200;

fn token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).ok();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Script injecté AVANT tout script de la page. Il capture `fetch` tout de
/// suite : une page ne peut donc pas l'instrumenter pour lire le jeton, ni
/// intercepter l'envoi.
fn init_script(port: u16, token: &str) -> String {
    format!(
        r#"(function () {{
  var post = window.fetch.bind(window);
  var url = "http://127.0.0.1:{port}/";
  var tok = "{token}";
  var sent = false;
  function send() {{
    if (sent) return;
    sent = true;
    var html = "";
    try {{ html = document.documentElement.outerHTML; }} catch (e) {{ html = ""; }}
    try {{
      post(url, {{
        method: "POST",
        // text/plain + jeton dans le corps : requête « simple » au sens CORS,
        // donc pas de préflight à négocier avec la page.
        headers: {{ "Content-Type": "text/plain" }},
        body: tok + "\n" + html,
        mode: "cors",
        credentials: "omit",
      }});
    }} catch (e) {{}}
  }}
  function schedule() {{ setTimeout(send, {SETTLE_MS}); }}
  if (document.readyState === "complete") schedule();
  else window.addEventListener("load", schedule);
  // Filet : certaines pages ne déclenchent jamais `load` (ressource pendante).
  setTimeout(send, {SETTLE_MS} * 6);
}})();"#
    )
}

/// Charge `url` dans une WebView cachée et renvoie le DOM après exécution du
/// JavaScript. `Err` si la page n'a rien renvoyé dans le délai imparti.
pub async fn render_html(app: &tauri::AppHandle, url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|_| "URL invalide.".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Schéma refusé : http(s) uniquement.".into());
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("Port de rendu indisponible : {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let tok = token();

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let slot = Arc::new(Mutex::new(Some(tx)));
    let expected = tok.clone();
    let server = tauri::async_runtime::spawn(async move {
        let app_router = axum::Router::new().route(
            "/",
            axum::routing::post(move |body: String| {
                let slot = slot.clone();
                let expected = expected.clone();
                async move {
                    let (got, html) = body.split_once('\n').unwrap_or((body.as_str(), ""));
                    if got == expected {
                        if let Some(tx) = slot.lock().ok().and_then(|mut s| s.take()) {
                            let _ = tx.send(html.to_string());
                        }
                    }
                    // Le corps de la réponse n'est jamais lu par la page : elle
                    // n'a pas besoin de savoir si le dépôt a été accepté.
                    ([(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")], "")
                }
            }),
        );
        let _ = axum::serve(listener, app_router).await;
    });

    // Label unique : deux rendus simultanés ne doivent pas se marcher dessus.
    let label = format!("web-render-{port}");
    // Création SUR LE THREAD PRINCIPAL. Ce chemin est aussi emprunté par la
    // boucle agentique, qui tourne dans un `spawn_blocking` : ouvrir une fenêtre
    // depuis un thread quelconque n'est pas permis par les systèmes de fenêtrage
    // (macOS en particulier). On passe donc par la file du thread principal, et
    // on récupère l'échec éventuel par un canal — le rendu reste un bonus, il ne
    // doit jamais faire tomber l'agent.
    let script = init_script(port, &tok);
    let (built_tx, built_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let label_main = label.clone();
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        let outcome = WebviewWindowBuilder::new(
            &app_main,
            &label_main,
            WebviewUrl::External(parsed),
        )
        .title("Lumen — rendu de page")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .incognito(true)
        .initialization_script(&script)
        .build()
        .map(|_| ())
        .map_err(|e| format!("Fenêtre de rendu impossible : {e}"));
        let _ = built_tx.send(outcome);
    })
    .map_err(|e| format!("Thread principal indisponible : {e}"))?;
    match built_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            server.abort();
            return Err(e);
        }
        Err(e) => {
            server.abort();
            return Err(format!("Fenêtre de rendu non ouverte : {e}"));
        }
    }

    let outcome = tokio::time::timeout(RENDER_TIMEOUT, rx).await;
    server.abort();
    // Fermeture systématique : une fenêtre de rendu oubliée continuerait à faire
    // tourner le JavaScript de la page, invisible, jusqu'à la fin de la session.
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }

    match outcome {
        Ok(Ok(html)) if !html.trim().is_empty() => Ok(html),
        Ok(Ok(_)) => Err("La page rendue est vide.".into()),
        Ok(Err(_)) => Err("Rendu interrompu.".into()),
        Err(_) => Err("Délai de rendu dépassé (la page bloque peut-être la requête locale).".into()),
    }
}
