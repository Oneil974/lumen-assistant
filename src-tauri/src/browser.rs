//! Navigateur complet de Lumen : de vrais onglets natifs, pas des iframes.
//!
//! Beaucoup de sites (ENT, Moodle, Teams, Google Docs, banques) refusent de
//! s'afficher dans une iframe (`X-Frame-Options`, `frame-ancestors`) : le
//! navigateur « iframe » de Lumen ne pouvait pas les ouvrir. Ici, une fenêtre
//! `lumen-browser` porte :
//!   - une barre d'interface Lumen (`browser/chrome.html`, webview locale :
//!     onglets, adresse, favoris, téléchargements, extensions, assistant) ;
//!   - un webview NATIF par onglet (label `btab-<n>`), exactement comme un
//!     navigateur système : cookies et comptes persistants, connexions SSO,
//!     téléchargements. Un onglet privé utilise un stockage éphémère.
//!
//! Sécurité : les pages web n'ont AUCUN accès à Lumen (pas d'IPC : origine
//! distante, hors des capacités). Seuls http(s) et about: sont navigables.
//! Les « extensions » sont des scripts utilisateur injectés au chargement des
//! pages dont l'adresse correspond à leur motif, plus un bloqueur de publicités
//! cosmétique intégré.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

pub const WINDOW: &str = "lumen-browser";
const CHROME: &str = "browser-chrome";
const CHROME_H: f64 = 96.0;
const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Tab {
    pub id: u32,
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub private: bool,
    #[serde(skip_deserializing, default)]
    pub loading: bool,
}

#[derive(Default)]
pub struct BrowserState {
    tabs: Mutex<Vec<Tab>>,
    active: Mutex<Option<u32>>,
    next: Mutex<u32>,
    /// Largeur réservée à droite pour le volet de l'assistant (px logiques).
    side: Mutex<f64>,
    /// Clé secrète de chaque onglet pour le canal du menu contextuel.
    nonces: Mutex<std::collections::HashMap<u32, String>>,
    /// Contexte du dernier clic droit, lu quand l'utilisateur choisit une entrée.
    ctx: Mutex<Option<(u32, CtxInfo)>>,
    /// Langue de l'interface (« fr » / « en »), donnée par la barre du navigateur.
    lang: Mutex<String>,
}

/// Ce qu'il y avait sous le clic droit, envoyé par le script de la page.
#[derive(Deserialize, Clone, Default, Debug)]
pub struct CtxInfo {
    #[serde(default)]
    pub link: String,
    #[serde(default)]
    pub image: String,
    #[serde(default)]
    pub selection: String,
    #[serde(default)]
    pub editable: bool,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
}

/// Préfixe (invisible) du canal : un titre de document qui commence par lui
/// n'est PAS un titre, c'est un clic droit à traiter.
const CTX_MARK: &str = "\u{2063}LUMENCTX";

#[derive(Serialize, Deserialize, Clone)]
pub struct Extension {
    pub id: String,
    pub name: String,
    /// Motifs d'adresse séparés par des virgules (`*` joker), ex. `*://*.moodle.*/*`.
    #[serde(default)]
    pub matches: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub css: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub builtin: bool,
}
fn yes() -> bool { true }

fn data_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

fn label(id: u32) -> String { format!("btab-{id}") }

fn builtin_extensions() -> Vec<Extension> {
    vec![
        Extension {
            id: "adblock".into(), name: "Bloqueur de publicités (cosmétique)".into(), matches: "*".into(), builtin: true, enabled: true,
            code: String::new(),
            css: "[id^='google_ads'],[id*='-ad-'],[class*='ad-banner'],[class*='adsbygoogle'],ins.adsbygoogle,iframe[src*='doubleclick'],iframe[src*='googlesyndication'],[aria-label='Advertisement'],[data-ad],[data-ad-slot],.ad,.ads,.advert,.advertisement,.sponsored,#cookie-banner-ads{display:none!important}".into(),
        },
        Extension {
            id: "darkmode".into(), name: "Mode sombre forcé".into(), matches: "*".into(), builtin: true, enabled: false,
            code: String::new(),
            css: "html{filter:invert(.92) hue-rotate(180deg)!important;background:#111!important}img,video,picture,canvas,iframe,svg image{filter:invert(1) hue-rotate(180deg)!important}".into(),
        },
        Extension {
            id: "readable".into(), name: "Lecture confortable (texte plus grand)".into(), matches: "*".into(), builtin: true, enabled: false,
            code: String::new(),
            css: "body{font-size:112%!important;line-height:1.6!important}p,li{max-width:75ch}".into(),
        },
    ]
}

fn read_extensions(app: &tauri::AppHandle) -> Vec<Extension> {
    let stored: Vec<Extension> = data_file(app, "browser-extensions.json")
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut out = builtin_extensions();
    for b in out.iter_mut() {
        if let Some(s) = stored.iter().find(|s| s.id == b.id) {
            b.enabled = s.enabled;
        }
    }
    out.extend(stored.into_iter().filter(|s| !s.builtin));
    out
}

/// Script injecté au début de chaque page : n'active que les extensions dont
/// le motif correspond à l'adresse courante.
fn injection_script(app: &tauri::AppHandle) -> String {
    let exts: Vec<serde_json::Value> = read_extensions(app)
        .into_iter()
        .filter(|e| e.enabled)
        .map(|e| serde_json::json!({ "m": e.matches, "js": e.code, "css": e.css }))
        .collect();
    format!(
        r#"(function(){{try{{
var X={exts};
function ok(p){{return String(p||"*").split(",").some(function(g){{g=g.trim();if(!g||g==="*")return true;var re=new RegExp("^"+g.replace(/[.+?^${{}}()|[\]\\]/g,"\\$&").replace(/\*/g,".*")+"$");return re.test(location.href);}});}}
X.forEach(function(e){{if(!ok(e.m))return;
if(e.css){{var add=function(){{var s=document.createElement("style");s.textContent=e.css;(document.head||document.documentElement).appendChild(s);}};if(document.documentElement)add();else document.addEventListener("DOMContentLoaded",add);}}
if(e.js){{try{{(new Function(e.js))();}}catch(err){{console.warn("[Lumen extension]",err);}}}}
}});}}catch(e){{}}}})();"#,
        exts = serde_json::Value::Array(exts)
    )
}

/// Menu contextuel : les pages n'ont aucun accès à Lumen (pas d'IPC). Le script
/// injecté signale donc un clic droit par le seul canal qui remonte d'une page
/// sans permission — un changement de titre, marqué d'une clé propre à
/// l'onglet et aussitôt annulé. Maj + clic droit garde le menu du moteur.
fn context_script(nonce: &str) -> String {
    format!(
        r#"(function(){{var K={key};document.addEventListener("contextmenu",function(e){{
if(e.shiftKey)return;e.preventDefault();
var t=e.target,a=t&&t.closest?t.closest("a[href]"):null,im=t&&t.closest?t.closest("img"):null;
var ed=!!(t&&(t.isContentEditable||/^(INPUT|TEXTAREA)$/.test(t.tagName)));
var d={{link:a?a.href:"",image:im?(im.currentSrc||im.src||""):"",selection:String(window.getSelection()||"").slice(0,8000),editable:ed,x:e.clientX,y:e.clientY,url:location.href,title:document.title}};
var old=document.title;document.title=K+JSON.stringify(d);setTimeout(function(){{document.title=old;}},60);
}},true);}})();"#,
        key = serde_json::to_string(&format!("{CTX_MARK}{nonce}:")).unwrap_or_default()
    )
}

fn save_session(app: &tauri::AppHandle) {
    let st = app.state::<BrowserState>();
    let tabs: Vec<Tab> = st.tabs.lock().unwrap().iter().filter(|t| !t.private).cloned().collect();
    let active = *st.active.lock().unwrap();
    if let Ok(p) = data_file(app, "browser-session.json") {
        let _ = fs::write(p, serde_json::json!({ "tabs": tabs, "active": active }).to_string());
    }
}

fn emit_tabs(app: &tauri::AppHandle) {
    let st = app.state::<BrowserState>();
    let tabs = st.tabs.lock().unwrap().clone();
    let active = *st.active.lock().unwrap();
    let _ = app.emit_to(tauri::EventTarget::webview(CHROME), "browser-tabs", serde_json::json!({ "tabs": tabs, "active": active }));
}

fn update_tab(app: &tauri::AppHandle, id: u32, f: impl FnOnce(&mut Tab)) {
    {
        let st = app.state::<BrowserState>();
        let mut tabs = st.tabs.lock().unwrap();
        if let Some(t) = tabs.iter_mut().find(|t| t.id == id) {
            f(t);
        }
    }
    emit_tabs(app);
    save_session(app);
}

/// Rectangle de la zone de page (sous la barre, à gauche du volet latéral).
fn content_rect(app: &tauri::AppHandle) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let side = *app.state::<BrowserState>().side.lock().unwrap();
    let (w, h) = app
        .get_window(WINDOW)
        .and_then(|win| {
            let scale = win.scale_factor().ok()?;
            let s = win.inner_size().ok()?;
            Some((s.width as f64 / scale, s.height as f64 / scale))
        })
        .unwrap_or((1200.0, 800.0));
    (LogicalPosition::new(0.0, CHROME_H), LogicalSize::new((w - side).max(200.0), (h - CHROME_H).max(100.0)))
}

fn relayout(app: &tauri::AppHandle) {
    let Some(win) = app.get_window(WINDOW) else { return };
    let (Ok(scale), Ok(size)) = (win.scale_factor(), win.inner_size()) else { return };
    let (w, h) = (size.width as f64 / scale, size.height as f64 / scale);
    if let Some(chrome) = app.get_webview(CHROME) {
        let _ = chrome.set_position(LogicalPosition::new(0.0, 0.0));
        let _ = chrome.set_size(LogicalSize::new(w, h));
    }
    let (pos, sz) = content_rect(app);
    let active = *app.state::<BrowserState>().active.lock().unwrap();
    for t in app.state::<BrowserState>().tabs.lock().unwrap().iter() {
        if let Some(wv) = app.get_webview(&label(t.id)) {
            let _ = wv.set_position(pos);
            let _ = wv.set_size(sz);
            if Some(t.id) == active { let _ = wv.show(); } else { let _ = wv.hide(); }
        }
    }
}

fn safe_url(raw: &str) -> Result<url::Url, String> {
    let raw = raw.trim();
    let candidate = if raw.is_empty() {
        "about:blank".to_string()
    } else if raw.contains("://") || raw.starts_with("about:") {
        raw.to_string()
    } else if raw.contains('.') && !raw.contains(' ') {
        format!("https://{raw}")
    } else {
        format!("https://duckduckgo.com/?q={}", url::form_urlencoded::byte_serialize(raw.as_bytes()).collect::<String>())
    };
    let u = url::Url::parse(&candidate).map_err(|e| e.to_string())?;
    match u.scheme() {
        "http" | "https" | "about" => Ok(u),
        s => Err(format!("Adresse « {s}: » non autorisée dans le navigateur.")),
    }
}

fn downloads_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path().download_dir().unwrap_or_else(|_| std::env::temp_dir())
}

fn unique_path(dir: &PathBuf, name: &str) -> PathBuf {
    let name = if name.trim().is_empty() { "telechargement" } else { name };
    let mut p = dir.join(name);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.to_string(), String::new()),
    };
    let mut n = 1;
    while p.exists() {
        p = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    p
}

fn create_tab(app: &tauri::AppHandle, url: url::Url, private: bool) -> Result<u32, String> {
    let win = app.get_window(WINDOW).ok_or("Fenêtre du navigateur absente")?;
    let st = app.state::<BrowserState>();
    let id = {
        let mut n = st.next.lock().unwrap();
        *n += 1;
        *n
    };
    let (pos, size) = content_rect(app);
    let (a1, a2, a3, a4, a5) = (app.clone(), app.clone(), app.clone(), app.clone(), app.clone());
    let nonce = {
        let mut b = [0u8; 12];
        let _ = getrandom::getrandom(&mut b);
        b.iter().map(|x| format!("{x:02x}")).collect::<String>()
    };
    st.nonces.lock().unwrap().insert(id, nonce.clone());
    let mut builder = WebviewBuilder::new(label(id), WebviewUrl::External(url.clone()))
        .initialization_script(injection_script(app))
        .initialization_script(context_script(&nonce))
        .incognito(private)
        .on_navigation(move |u| {
            let ok = matches!(u.scheme(), "http" | "https" | "about" | "blob" | "data");
            if ok {
                let s = u.to_string();
                update_tab(&a1, id, |t| { t.url = s; t.loading = true; });
            }
            ok
        })
        .on_page_load(move |wv, payload| {
            let done = matches!(payload.event(), tauri::webview::PageLoadEvent::Finished);
            let url = wv.url().map(|u| u.to_string()).unwrap_or_default();
            update_tab(&a2, id, |t| { t.loading = !done; if !url.is_empty() { t.url = url; } });
        })
        .on_document_title_changed(move |_wv, title| {
            if let Some(rest) = title.strip_prefix(CTX_MARK) {
                // Clé de l'onglet vérifiée : une page ne peut pas faire
                // apparaître le menu d'un autre onglet ni le déclencher seule
                // sans connaître la clé.
                let expected = a3.state::<BrowserState>().nonces.lock().unwrap().get(&id).cloned().unwrap_or_default();
                if let Some(json) = rest.strip_prefix(&format!("{expected}:")) {
                    if let Ok(info) = serde_json::from_str::<CtxInfo>(json) {
                        show_context_menu(&a3, id, info);
                    }
                }
                return;
            }
            update_tab(&a3, id, |t| t.title = title);
        })
        .on_download(move |_wv, ev| {
            match ev {
                tauri::webview::DownloadEvent::Requested { url, destination } => {
                    let name = destination
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .filter(|n| !n.is_empty())
                        .or_else(|| url.path_segments().and_then(|s| s.last().map(|x| x.to_string())))
                        .unwrap_or_default();
                    let target = unique_path(&downloads_dir(&a4), &name);
                    *destination = target.clone();
                    let _ = a4.emit_to(tauri::EventTarget::webview(CHROME), "browser-download",
                        serde_json::json!({ "url": url.to_string(), "path": target, "state": "started" }));
                }
                tauri::webview::DownloadEvent::Finished { url, path, success } => {
                    let _ = a4.emit_to(tauri::EventTarget::webview(CHROME), "browser-download",
                        serde_json::json!({ "url": url.to_string(), "path": path, "state": if success { "done" } else { "failed" } }));
                }
                _ => {}
            }
            true
        })
        .on_new_window(move |u, _features| {
            // Lien « nouvel onglet » : ouvert comme un onglet de Lumen. Les
            // fenêtres de connexion (SSO Google/Microsoft…) gardent le
            // comportement natif : elles ont besoin de `window.opener`.
            let host = u.host_str().unwrap_or("").to_string();
            let sso = ["accounts.google.com", "login.microsoftonline.com", "login.live.com", "appleid.apple.com", "github.com/login"]
                .iter().any(|h| host.ends_with(h));
            if sso {
                return tauri::webview::NewWindowResponse::Allow;
            }
            let app = a5.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(id) = create_tab(&app, u, private) { activate(&app, id); }
            });
            tauri::webview::NewWindowResponse::Deny
        });
    // Les sites testent le navigateur : WKWebView/WebKitGTK s'annoncent sans
    // « Safari » et certains (Teams, Docs) refusent alors de s'ouvrir.
    if !cfg!(windows) {
        builder = builder.user_agent(SAFARI_UA);
    }
    win.add_child(builder, pos, size).map_err(|e| e.to_string())?;
    st.tabs.lock().unwrap().push(Tab { id, url: url.to_string(), title: String::new(), private, loading: true });
    Ok(id)
}

fn show_context_menu(app: &tauri::AppHandle, id: u32, info: CtxInfo) {
    use tauri::menu::{MenuBuilder, PredefinedMenuItem};
    let Some(win) = app.get_window(WINDOW) else { return };
    let fr = app.state::<BrowserState>().lang.lock().unwrap().as_str() != "en";
    let t = |f: &'static str, e: &'static str| if fr { f } else { e };
    let short = |s: &str| {
        let s: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if s.chars().count() > 28 { format!("{}…", s.chars().take(27).collect::<String>()) } else { s }
    };
    let mut m = MenuBuilder::new(app);
    if !info.link.is_empty() {
        m = m.text("bctx:link_tab", t("Ouvrir le lien dans un nouvel onglet", "Open link in new tab"))
            .text("bctx:link_private", t("Ouvrir le lien dans un onglet privé", "Open link in private tab"))
            .text("bctx:link_system", t("Ouvrir le lien dans le navigateur du système", "Open link in system browser"))
            .text("bctx:link_save", t("Enregistrer le lien sous Téléchargements", "Save link to Downloads"))
            .text("bctx:link_copy", t("Copier l'adresse du lien", "Copy link address"))
            .separator();
    }
    if !info.image.is_empty() {
        m = m.text("bctx:img_tab", t("Ouvrir l'image dans un nouvel onglet", "Open image in new tab"))
            .text("bctx:img_save", t("Enregistrer l'image dans Téléchargements", "Save image to Downloads"))
            .text("bctx:img_copy", t("Copier l'adresse de l'image", "Copy image address"))
            .separator();
    }
    if info.editable {
        if let (Ok(cut), Ok(copy), Ok(paste), Ok(all)) = (
            PredefinedMenuItem::cut(app, None), PredefinedMenuItem::copy(app, None),
            PredefinedMenuItem::paste(app, None), PredefinedMenuItem::select_all(app, None),
        ) {
            m = m.item(&cut).item(&copy).item(&paste).item(&all).separator();
        }
    }
    if !info.selection.trim().is_empty() {
        let s = short(&info.selection);
        if !info.editable {
            m = m.text("bctx:sel_copy", t("Copier", "Copy"));
        }
        m = m.text("bctx:sel_search", format!("{} « {s} »", t("Rechercher", "Search for")))
            .text("bctx:sel_explain", t("Expliquer avec l'assistant", "Explain with the assistant"))
            .text("bctx:sel_translate", t("Traduire la sélection", "Translate selection"))
            .text("bctx:sel_notes", t("Envoyer vers Notes", "Send to Notes"))
            .text("bctx:sel_studies", t("Créer des fiches (Études)", "Create cards (Studies)"))
            .separator();
    }
    m = m.text("bctx:back", t("Précédent", "Back"))
        .text("bctx:forward", t("Suivant", "Forward"))
        .text("bctx:reload", t("Recharger", "Reload"))
        .separator()
        .text("bctx:page_summary", t("Résumer la page", "Summarize the page"))
        .text("bctx:page_bookmark", t("Ajouter aux favoris", "Add to bookmarks"))
        .text("bctx:page_copy", t("Copier l'adresse de la page", "Copy page address"))
        .text("bctx:page_system", t("Ouvrir la page dans le navigateur du système", "Open page in system browser"))
        .text("bctx:print", t("Imprimer / enregistrer en PDF…", "Print / save as PDF…"));
    let Ok(menu) = m.build() else { return };
    *app.state::<BrowserState>().ctx.lock().unwrap() = Some((id, info.clone()));
    let _ = win.popup_menu_at(&menu, LogicalPosition::new(info.x, info.y + CHROME_H));
}

fn copy_text(text: &str) {
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(text.to_string());
    }
}

/// Téléchargement direct (image, lien) vers le dossier Téléchargements, avec
/// les mêmes évènements que les téléchargements de page.
fn download_to_downloads(app: &tauri::AppHandle, url: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        let name = url::Url::parse(&url).ok()
            .and_then(|u| u.path_segments().and_then(|s| s.last().map(|x| x.to_string())))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "telechargement".into());
        let target = unique_path(&downloads_dir(&app), &url::form_urlencoded::parse(format!("n={name}").as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or(name));
        let emit = |state: &str| {
            let _ = app.emit_to(tauri::EventTarget::webview(CHROME), "browser-download",
                serde_json::json!({ "url": url, "path": target, "state": state }));
        };
        emit("started");
        let ok = url.starts_with("http") && reqwest::blocking::Client::builder()
            .user_agent(SAFARI_UA).timeout(std::time::Duration::from_secs(120)).build()
            .and_then(|c| c.get(&url).send())
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.bytes())
            .map(|b| fs::write(&target, &b).is_ok())
            .unwrap_or(false);
        emit(if ok { "done" } else { "failed" });
    });
}

fn on_context_action(app: &tauri::AppHandle, action: &str) {
    use tauri_plugin_opener::OpenerExt;
    let Some((id, info)) = app.state::<BrowserState>().ctx.lock().unwrap().clone() else { return };
    let chrome = |kind: &str, text: &str| {
        let _ = app.emit_to(tauri::EventTarget::webview(CHROME), "browser-ctx",
            serde_json::json!({ "action": kind, "text": text, "url": info.url, "title": info.title }));
    };
    let open_tab = |url: &str, private: bool| {
        if let Ok(u) = safe_url(url) {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { if let Ok(n) = create_tab(&app, u, private) { activate(&app, n); } });
        }
    };
    let eval = |js: &str| { if let Some(wv) = app.get_webview(&label(id)) { let _ = wv.eval(js); } };
    match action {
        "link_tab" => open_tab(&info.link, false),
        "link_private" => open_tab(&info.link, true),
        "link_system" => { let _ = app.opener().open_url(info.link.clone(), None::<&str>); }
        "link_save" => download_to_downloads(app, info.link.clone()),
        "link_copy" => copy_text(&info.link),
        "img_tab" => open_tab(&info.image, false),
        "img_save" => download_to_downloads(app, info.image.clone()),
        "img_copy" => copy_text(&info.image),
        "sel_copy" => copy_text(&info.selection),
        "sel_search" => open_tab(&info.selection, false),
        "sel_explain" => chrome("explain", &info.selection),
        "sel_translate" => chrome("translate", &info.selection),
        "sel_notes" => chrome("notes", &info.selection),
        "sel_studies" => chrome("studies", &info.selection),
        "back" => eval("history.back()"),
        "forward" => eval("history.forward()"),
        "reload" => { if let Some(wv) = app.get_webview(&label(id)) { let _ = wv.reload(); } }
        "page_summary" => chrome("summary", ""),
        "page_bookmark" => chrome("bookmark", ""),
        "page_copy" => copy_text(&info.url),
        "page_system" => { let _ = app.opener().open_url(info.url.clone(), None::<&str>); }
        "print" => eval("window.print()"),
        _ => {}
    }
}

fn activate(app: &tauri::AppHandle, id: u32) {
    *app.state::<BrowserState>().active.lock().unwrap() = Some(id);
    relayout(app);
    emit_tabs(app);
    save_session(app);
}

fn ensure_window(app: &tauri::AppHandle) -> Result<bool, String> {
    if let Some(w) = app.get_window(WINDOW) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(false);
    }
    let win = tauri::window::WindowBuilder::new(app, WINDOW)
        .title("Lumen — Navigateur")
        .inner_size(1280.0, 840.0)
        .min_inner_size(720.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    let (w, h) = win
        .inner_size()
        .ok()
        .zip(win.scale_factor().ok())
        .map(|(s, f)| (s.width as f64 / f, s.height as f64 / f))
        .unwrap_or((1280.0, 840.0));
    win.add_child(
        WebviewBuilder::new(CHROME, WebviewUrl::App("browser/chrome.html".into())),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(w, h),
    )
    .map_err(|e| e.to_string())?;
    let app3 = app.clone();
    win.on_menu_event(move |_w, ev| {
        if let Some(action) = ev.id().as_ref().strip_prefix("bctx:") {
            on_context_action(&app3, action);
        }
    });
    let app2 = app.clone();
    win.on_window_event(move |ev| match ev {
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => relayout(&app2),
        tauri::WindowEvent::Destroyed => {
            let st = app2.state::<BrowserState>();
            st.tabs.lock().unwrap().clear();
            *st.active.lock().unwrap() = None;
        }
        _ => {}
    });
    Ok(true)
}

// ===== Commandes ===============================================================

/// Ouvre (ou ramène) le navigateur ; `url` ouvre un onglet de plus.
#[tauri::command]
pub async fn browser_open(app: tauri::AppHandle, url: Option<String>) -> Result<(), String> {
    let created = ensure_window(&app)?;
    if created {
        // Session précédente : onglets restaurés, dans l'ordre.
        let saved: serde_json::Value = data_file(&app, "browser-session.json")
            .ok()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut first = None;
        for t in saved["tabs"].as_array().cloned().unwrap_or_default() {
            if let Ok(u) = safe_url(t["url"].as_str().unwrap_or("")) {
                if let Ok(id) = create_tab(&app, u, false) {
                    first.get_or_insert(id);
                }
            }
        }
        if let Some(id) = first { activate(&app, id); }
    }
    let has_tabs = !app.state::<BrowserState>().tabs.lock().unwrap().is_empty();
    if url.is_some() || !has_tabs {
        let u = safe_url(url.as_deref().unwrap_or("https://duckduckgo.com"))?;
        let id = create_tab(&app, u, false)?;
        activate(&app, id);
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_new_tab(app: tauri::AppHandle, url: Option<String>, private: Option<bool>) -> Result<u32, String> {
    let u = safe_url(url.as_deref().unwrap_or("https://duckduckgo.com"))?;
    let id = create_tab(&app, u, private.unwrap_or(false))?;
    activate(&app, id);
    Ok(id)
}

#[tauri::command]
pub fn browser_close_tab(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label(id)) {
        let _ = wv.close();
    }
    let st = app.state::<BrowserState>();
    let next = {
        let mut tabs = st.tabs.lock().unwrap();
        let idx = tabs.iter().position(|t| t.id == id);
        tabs.retain(|t| t.id != id);
        idx.and_then(|i| tabs.get(i.min(tabs.len().saturating_sub(1))).map(|t| t.id))
    };
    let was_active = *st.active.lock().unwrap() == Some(id);
    if was_active {
        *st.active.lock().unwrap() = next;
    }
    relayout(&app);
    emit_tabs(&app);
    save_session(&app);
    Ok(())
}

#[tauri::command]
pub fn browser_activate(app: tauri::AppHandle, id: u32) { activate(&app, id); }

#[tauri::command]
pub fn browser_tabs(app: tauri::AppHandle) -> serde_json::Value {
    let st = app.state::<BrowserState>();
    let tabs = st.tabs.lock().unwrap().clone();
    let active = *st.active.lock().unwrap();
    serde_json::json!({ "tabs": tabs, "active": active })
}

#[tauri::command]
pub fn browser_navigate(app: tauri::AppHandle, id: u32, url: String) -> Result<String, String> {
    let u = safe_url(&url)?;
    let wv = app.get_webview(&label(id)).ok_or("Onglet introuvable")?;
    wv.navigate(u.clone()).map_err(|e| e.to_string())?;
    Ok(u.to_string())
}

/// `back`, `forward`, `reload`, `stop`, `zoom-in`, `zoom-out`, `zoom-reset`, `print`.
#[tauri::command]
pub fn browser_action(app: tauri::AppHandle, id: u32, action: String) -> Result<(), String> {
    let wv = app.get_webview(&label(id)).ok_or("Onglet introuvable")?;
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => { return wv.reload().map_err(|e| e.to_string()); }
        "stop" => "window.stop()",
        "zoom-in" => "document.documentElement.style.zoom=((parseFloat(document.documentElement.style.zoom)||1)+0.1).toFixed(2)",
        "zoom-out" => "document.documentElement.style.zoom=Math.max(0.3,(parseFloat(document.documentElement.style.zoom)||1)-0.1).toFixed(2)",
        "zoom-reset" => "document.documentElement.style.zoom=1",
        "print" => "window.print()",
        _ => return Err("Action inconnue".into()),
    };
    wv.eval(js).map_err(|e| e.to_string())
}

/// Recherche dans la page : `query` vide efface la sélection.
#[tauri::command]
pub fn browser_find(app: tauri::AppHandle, id: u32, query: String, backwards: Option<bool>) -> Result<(), String> {
    let wv = app.get_webview(&label(id)).ok_or("Onglet introuvable")?;
    let q = serde_json::to_string(&query).unwrap_or_default();
    wv.eval(format!("window.find && window.find({q}, false, {}, true)", backwards.unwrap_or(false)))
        .map_err(|e| e.to_string())
}

/// Texte lisible de la page de l'onglet — c'est ce qui permet à l'assistant
/// de résumer une page derrière une connexion (Moodle, ENT…), que `web_fetch`
/// ne verrait pas.
#[tauri::command]
pub async fn browser_page_text(app: tauri::AppHandle, id: u32) -> Result<serde_json::Value, String> {
    let wv = app.get_webview(&label(id)).ok_or("Onglet introuvable")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    wv.eval_with_callback(
        r#"(function(){var m=document.querySelector("article,main,[role=main]")||document.body;return JSON.stringify({title:document.title,url:location.href,text:(m&&m.innerText||"").slice(0,60000),selection:String(window.getSelection()||"").slice(0,20000)});})()"#,
        move |res| { let _ = tx.send(res); },
    )
    .map_err(|e| e.to_string())?;
    let raw = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(8)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "La page n'a pas répondu.".to_string())?;
    // Le résultat est une chaîne JSON… elle-même sérialisée en JSON.
    let inner: String = serde_json::from_str(&raw).unwrap_or(raw);
    serde_json::from_str(&inner).map_err(|e| e.to_string())
}

/// Exécute un script dans l'onglet et rend son résultat (chaîne JSON).
async fn eval_json(app: &tauri::AppHandle, id: u32, js: String) -> Result<serde_json::Value, String> {
    let wv = app.get_webview(&label(id)).ok_or("Onglet introuvable")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    wv.eval_with_callback(js, move |res| { let _ = tx.send(res); }).map_err(|e| e.to_string())?;
    let raw = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(10)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "La page n'a pas répondu.".to_string())?;
    let inner: String = serde_json::from_str(&raw).unwrap_or(raw);
    serde_json::from_str(&inner).map_err(|e| e.to_string())
}

/// Instantané « agent » de la page : titre, adresse, texte visible abrégé et
/// éléments interactifs VISIBLES numérotés (`data-lumen-ref`), pour que le
/// modèle désigne un élément par son numéro plutôt que par un sélecteur.
const SNAPSHOT_JS: &str = r#"(function(){
 var sel='a[href],button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=true],summary,label[for]';
 var out=[],n=0;document.querySelectorAll('[data-lumen-ref]').forEach(function(e){e.removeAttribute('data-lumen-ref')});
 document.querySelectorAll(sel).forEach(function(e){
  if(n>=150)return;var r=e.getBoundingClientRect(),st=getComputedStyle(e);
  if(r.width<2||r.height<2||st.visibility=='hidden'||st.display=='none')return;
  if(r.bottom<-200||r.top>innerHeight*3)return;
  var t=(e.getAttribute('aria-label')||e.innerText||e.value||e.placeholder||e.title||e.alt||e.name||'').replace(/\s+/g,' ').trim().slice(0,80);
  var tag=e.tagName.toLowerCase(),type=(e.getAttribute('type')||'').toLowerCase();
  if(!t&&tag!='input'&&tag!='textarea'&&tag!='select')return;
  n++;e.setAttribute('data-lumen-ref',String(n));
  var o={ref:n,tag:tag,text:t};if(type)o.type=type;if(e.href)o.href=String(e.href).slice(0,120);
  if(tag=='input'||tag=='textarea')o.value=(type=='password')?'***':String(e.value||'').slice(0,60);
  if(tag=='select')o.options=Array.from(e.options).slice(0,12).map(function(x){return x.text.trim()});
  if(e.disabled)o.disabled=true;if(r.top>innerHeight||r.bottom<0)o.offscreen=true;out.push(o);
 });
 var m=document.querySelector('article,main,[role=main]')||document.body;
 return JSON.stringify({title:document.title,url:location.href,scroll:Math.round(scrollY),height:document.body.scrollHeight,text:(m&&m.innerText||'').replace(/\n{3,}/g,'\n\n').slice(0,6000),elements:out});
})()"#;

#[tauri::command]
pub async fn browser_agent_snapshot(app: tauri::AppHandle, id: u32) -> Result<serde_json::Value, String> {
    eval_json(&app, id, SNAPSHOT_JS.to_string()).await
}

/// Agit sur un élément numéroté par `browser_agent_snapshot`.
/// `action` : click | type | clear_type | select | press_enter | scroll | focus.
#[tauri::command]
pub async fn browser_agent_act(app: tauri::AppHandle, id: u32, action: String, r#ref: Option<u32>, text: Option<String>) -> Result<serde_json::Value, String> {
    let q = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
    let txt = q(text.as_deref().unwrap_or(""));
    let target = r#ref.map(|n| format!("document.querySelector('[data-lumen-ref=\"{n}\"]')")).unwrap_or_else(|| "null".into());
    let body = match action.as_str() {
        "scroll" => format!("var d={txt}=='up'?-0.8:0.8;scrollBy(0,innerHeight*d);return {{ok:true,scroll:Math.round(scrollY)}};"),
        "click" => format!("var e={target};if(!e)return {{ok:false,err:'élément introuvable : relis la page'}};e.scrollIntoView({{block:'center'}});e.click();return {{ok:true}};"),
        "focus" => format!("var e={target};if(!e)return {{ok:false,err:'élément introuvable'}};e.focus();return {{ok:true}};"),
        "type" | "clear_type" => format!(
            "var e={target};if(!e)return {{ok:false,err:'élément introuvable'}};e.scrollIntoView({{block:'center'}});e.focus();\
             var v=({clear}?'':(e.value||''))+{txt};\
             var p=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value');if(p&&p.set)p.set.call(e,v);else if(e.isContentEditable)e.innerText=v;else e.value=v;\
             e.dispatchEvent(new Event('input',{{bubbles:true}}));e.dispatchEvent(new Event('change',{{bubbles:true}}));return {{ok:true}};",
            clear = if action == "clear_type" { "true" } else { "false" }),
        "select" => format!("var e={target};if(!e||!e.options)return {{ok:false,err:'liste introuvable'}};var t={txt}.toLowerCase();\
             for(var i=0;i<e.options.length;i++){{if(e.options[i].text.trim().toLowerCase().indexOf(t)>=0){{e.selectedIndex=i;e.dispatchEvent(new Event('change',{{bubbles:true}}));return {{ok:true,picked:e.options[i].text.trim()}};}}}}return {{ok:false,err:'option absente'}};"),
        "press_enter" => format!("var e={target}||document.activeElement;if(!e)return {{ok:false}};\
             ['keydown','keypress','keyup'].forEach(function(k){{e.dispatchEvent(new KeyboardEvent(k,{{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}}))}});\
             if(e.form&&e.form.requestSubmit)e.form.requestSubmit();return {{ok:true}};"),
        _ => return Err(format!("action inconnue : {action}")),
    };
    eval_json(&app, id, format!("(function(){{try{{var r=(function(){{{body}}})();return JSON.stringify(r);}}catch(err){{return JSON.stringify({{ok:false,err:String(err)}})}}}})()")).await
}

/// Réserve `px` à droite de la page pour le volet de l'assistant (0 = fermé).
#[tauri::command]
pub fn browser_set_side(app: tauri::AppHandle, px: f64) {
    *app.state::<BrowserState>().side.lock().unwrap() = px.clamp(0.0, 640.0);
    relayout(&app);
}

/// La barre du navigateur annonce la langue de l'interface (menu contextuel natif).
#[tauri::command]
pub fn browser_set_lang(app: tauri::AppHandle, lang: String) {
    *app.state::<BrowserState>().lang.lock().unwrap() = if lang.starts_with("en") { "en".into() } else { "fr".into() };
}

#[tauri::command]
pub fn browser_extensions(app: tauri::AppHandle) -> Vec<Extension> { read_extensions(&app) }

/// Enregistre les extensions (scripts et styles utilisateur, état des
/// extensions intégrées). Prend effet au prochain chargement de page.
#[tauri::command]
pub fn browser_extensions_save(app: tauri::AppHandle, list: Vec<Extension>) -> Result<(), String> {
    for e in &list {
        if e.code.len() > 200_000 || e.css.len() > 200_000 {
            return Err(format!("Extension « {} » trop volumineuse.", e.name));
        }
    }
    let p = data_file(&app, "browser-extensions.json")?;
    fs::write(p, serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_script_carries_the_tab_key() {
        let js = context_script("abc123");
        assert!(js.contains("LUMENCTX") && js.contains("abc123:"));
        // Écrit pour que le harnais JS puisse vérifier la syntaxe du script.
        if let Ok(p) = std::env::var("LUMEN_DUMP_CTX") { let _ = std::fs::write(p, &js); }
    }

    #[test]
    fn urls_are_normalized_and_confined() {
        assert_eq!(safe_url("moodle.univ.fr").unwrap().as_str(), "https://moodle.univ.fr/");
        assert!(safe_url("photosynthèse cours").unwrap().as_str().starts_with("https://duckduckgo.com/?q="));
        assert!(safe_url("file:///etc/passwd").is_err());
        assert!(safe_url("tauri://localhost/index.html").is_err());
        // Sans « :// », c'est une recherche : jamais une URL javascript:.
        assert!(safe_url("javascript:alert(1)").map(|u| u.scheme() != "javascript").unwrap_or(true));
    }

}
