//! Accès micro/caméra de la WebView sous Linux (WebKitGTK).
//!
//! `getUserMedia` échouait sur Ubuntu en « NotAllowedError : The request is not
//! allowed by the user agent or the platform in the current context » — la
//! dictée Whisper, la visio Réunion et la caméra du compagnon étaient donc
//! inutilisables, alors que tout marche sur macOS et Windows. Deux raisons,
//! toutes deux propres à WebKitGTK et que wry (0.55) ne couvre pas :
//!
//!   1. les réglages `enable-media-stream` et `enable-webrtc` de WebKitSettings
//!      sont à FAUX par défaut — la WebView ne propose même pas l'API ;
//!   2. toute demande d'accès arrive au signal `permission-request` de la
//!      WebView ; sans gestionnaire, WebKit la REFUSE. Sur macOS c'est le
//!      délégué WKUIDelegate de wry qui accorde, sur Windows WebView2 ; sur
//!      Linux, personne.
//!
//! On ne peut pas passer par le constructeur (les fenêtres sont créées à des
//! dizaines d'endroits) : on s'accroche à `on_page_load`, qui livre chaque
//! Webview, et on ne configure chacune qu'une fois. Seules les demandes de
//! MÉDIA sont accordées (micro, caméra, énumération des périphériques) ; le
//! reste (géolocalisation, notifications web…) garde le refus par défaut.
//! Les pages viennent toutes du bundle (tauri:// et lumenapp://), jamais du
//! web ouvert : accorder sans dialogue est le même contrat que sur macOS, où
//! c'est le système qui demande une fois pour toutes.

#[cfg(target_os = "linux")]
pub fn configure<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    use std::collections::HashSet;
    use std::sync::Mutex;
    static DONE: Mutex<Option<HashSet<String>>> = Mutex::new(None);

    let label = webview.label().to_string();
    {
        let mut done = DONE.lock().unwrap();
        if !done.get_or_insert_with(HashSet::new).insert(label.clone()) {
            return;
        }
    }
    let result = webview.with_webview(move |platform| {
        use webkit2gtk::glib::prelude::*; // `is::<T>()` sur un objet GLib
        use webkit2gtk::{
            DeviceInfoPermissionRequest, PermissionRequestExt, SettingsExt,
            UserMediaPermissionRequest, WebViewExt,
        };
        let wv = platform.inner();
        if let Some(settings) = wv.settings() {
            settings.set_enable_media_stream(true);
            settings.set_enable_webrtc(true);
            settings.set_enable_mediasource(true);
        }
        wv.connect_permission_request(|_, request| {
            let granted = request.is::<UserMediaPermissionRequest>()
                || request.is::<DeviceInfoPermissionRequest>();
            if granted {
                request.allow();
            }
            // `true` = traité (accordé ci-dessus) ; `false` laisse WebKit
            // appliquer sa réponse par défaut, le refus.
            granted
        });
    });
    if let Err(e) = result {
        eprintln!("[webview] configuration média impossible pour « {label} » : {e}");
    }
}

#[cfg(not(target_os = "linux"))]
pub fn configure<R: tauri::Runtime>(_webview: &tauri::Webview<R>) {}
