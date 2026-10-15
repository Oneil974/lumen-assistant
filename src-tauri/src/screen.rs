//! Capture de l'écran pour la fonction « Comprendre cet écran ».
//!
//! Aucune dépendance supplémentaire : chaque plateforme a déjà un utilitaire de
//! capture, on l'appelle et on relit le PNG produit. Le bitmap brut d'un écran
//! Retina pèse plusieurs dizaines de mégaoctets — inutilisable tel quel par un
//! modèle vision, dont l'encodeur redimensionne de toute façon. On réduit donc
//! l'image côté Rust (largeur maximale demandée) et on la renvoie en JPEG
//! encodé en base64, prêt à partir dans un message multimodal.
//!
//! macOS demande l'autorisation « Enregistrement de l'écran » au premier appel :
//! `screencapture` renvoie alors une image vide ou une erreur, et le message
//! remonté à l'interface explique où l'accorder.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri::{Emitter, Manager};

/// Capture renvoyée à la WebView : base64 (sans préfixe `data:`) + dimensions.
#[derive(Serialize, Clone)]
pub struct ScreenCapture {
    /// Image JPEG encodée en base64, sans en-tête `data:`.
    pub image: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

#[allow(dead_code)] // inutilisé sous Linux, où la capture passe par un utilitaire tiers
fn hide_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Chemin temporaire unique pour le PNG intermédiaire.
fn temp_png() -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("lumen-screen-{}-{stamp}.png", std::process::id()))
}

/// Lance l'utilitaire de capture de la plateforme ; le PNG doit atterrir dans `path`.
fn shoot(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // -x : pas de son d'obturateur. Capture l'écran principal en entier.
        let mut cmd = Command::new("/usr/sbin/screencapture");
        cmd.arg("-x").arg("-t").arg("png").arg(path);
        hide_console_window(&mut cmd);
        let out = cmd
            .output()
            .map_err(|e| format!("capture d'écran impossible : {e}"))?;
        if !out.status.success() {
            // Le cas de loin le plus fréquent n'est pas un refus « normal » :
            // c'est une autorisation devenue caduque parce que la signature de
            // l'app a changé (build ad-hoc → nouvelle identité à chaque
            // compilation). L'entrée reste alors cochée dans les Réglages sans
            // s'appliquer. On oriente vers la bonne manœuvre plutôt que de
            // renvoyer un message que rien ne permet d'exploiter.
            let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!(
                "capture d'écran refusée par macOS{}. \
                 Vérifiez Réglages Système → Confidentialité et sécurité → \
                 Enregistrement de l'écran. Si Lumen y est déjà coché, l'autorisation \
                 vise une version précédente : retirez l'entrée avec « − », puis relancez.",
                if detail.is_empty() { String::new() } else { format!(" ({detail})") }
            ));
        }
        return Ok(());
    }

    #[cfg(windows)]
    {
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \
             $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; \
             $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); \
             $g=[System.Drawing.Graphics]::FromImage($bmp); \
             $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); \
             $bmp.Save('{}',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()",
            path.display().to_string().replace('\'', "''")
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        hide_console_window(&mut cmd);
        let out = cmd
            .output()
            .map_err(|e| format!("capture d'écran impossible : {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "capture d'écran impossible : {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Aucun utilitaire n'est universel sous Linux : Wayland (grim), KDE
        // (spectacle), GNOME, X11 (scrot, ImageMagick). On essaie dans l'ordre
        // et on s'arrête au premier qui produit un fichier.
        let file = path.display().to_string();
        let candidates: [(&str, Vec<String>); 5] = [
            ("grim", vec![file.clone()]),
            (
                "spectacle",
                vec!["-b".into(), "-n".into(), "-o".into(), file.clone()],
            ),
            ("gnome-screenshot", vec!["-f".into(), file.clone()]),
            ("scrot", vec!["-o".into(), file.clone()]),
            (
                "import",
                vec!["-window".into(), "root".into(), file.clone()],
            ),
        ];
        let mut last = String::new();
        for (bin, args) in candidates {
            let mut cmd = Command::new(bin);
            cmd.args(&args);
            match cmd.output() {
                Ok(out) if out.status.success() && path.is_file() => return Ok(()),
                Ok(out) => {
                    last = format!("{bin} : {}", String::from_utf8_lossy(&out.stderr).trim());
                }
                Err(e) => last = format!("{bin} : {e}"),
            }
        }
        return Err(format!(
            "aucun utilitaire de capture disponible (grim, spectacle, gnome-screenshot, scrot, import). {last}"
        ));
    }

    #[allow(unreachable_code)]
    Err("capture d'écran non prise en charge sur cette plateforme".into())
}

/// Réduit à `max_width` puis encode en JPEG base64.
fn encode(img: image::DynamicImage, max_width: u32) -> Result<ScreenCapture, String> {
    // 1280 px de large : au-delà, un modèle vision local découpe l'image en
    // tuiles et gonfle le contexte sans rien gagner en lisibilité.
    let max_width = max_width.clamp(320, 4096);
    let img = if img.width() > max_width {
        let height = (img.height() as u64 * max_width as u64 / img.width().max(1) as u64) as u32;
        img.resize(max_width, height.max(1), image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let (width, height) = (img.width(), img.height());
    let rgb = img.to_rgb8();
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 78)
        .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("encodage JPEG impossible : {e}"))?;
    Ok(ScreenCapture {
        image: STANDARD.encode(&jpeg),
        mime: "image/jpeg".into(),
        width,
        height,
    })
}

/// Capture l'écran en pleine résolution, sans réduction ni encodage.
fn grab() -> Result<image::DynamicImage, String> {
    let path = temp_png();
    let result = (|| {
        shoot(&path)?;
        let bytes = std::fs::read(&path).map_err(|e| format!("capture illisible : {e}"))?;
        if bytes.is_empty() {
            return Err("capture d'écran vide".to_string());
        }
        image::load_from_memory(&bytes).map_err(|e| format!("image de capture invalide : {e}"))
    })();
    // Le PNG intermédiaire ne doit pas rester dans /tmp : il contient l'écran.
    let _ = std::fs::remove_file(&path);
    result
}

/// Rectangle (x, y, largeur, hauteur) de la fenêtre au premier plan, en points.
/// Passe par System Events : il faut l'autorisation « Accessibilité ».
#[cfg(target_os = "macos")]
fn front_window_rect() -> Option<(i64, i64, i64, i64)> {
    let script = "tell application \"System Events\" to tell (first process whose frontmost is true) \
                  to get {position, size} of front window";
    let out = Command::new("/usr/bin/osascript").args(["-e", script]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let nums: Vec<i64> = String::from_utf8_lossy(&out.stdout)
        .split(',')
        .filter_map(|v| v.trim().parse().ok())
        .collect();
    (nums.len() == 4 && nums[2] > 0 && nums[3] > 0).then(|| (nums[0], nums[1], nums[2], nums[3]))
}

/// Une image de la recopie d'écran pour Lumen XR : l'écran entier (`screen`)
/// ou, sur macOS, la seule fenêtre au premier plan (`front`) — ce qu'on lit
/// vraiment (Opus, Calc, le navigateur…) plutôt qu'un bureau en miniature.
/// Même encodage JPEG que la capture pour l'IA.
#[tauri::command]
pub async fn screen_mirror_frame(mode: Option<String>, max_width: Option<u32>) -> Result<ScreenCapture, String> {
    let max = max_width.unwrap_or(1600);
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        if mode.as_deref() == Some("front") {
            if let Some((x, y, w, h)) = front_window_rect() {
                let path = temp_png();
                let result = (|| {
                    let out = Command::new("/usr/sbin/screencapture")
                        .arg("-x")
                        .arg("-t")
                        .arg("png")
                        .arg(format!("-R{x},{y},{w},{h}"))
                        .arg(&path)
                        .output()
                        .map_err(|e| format!("capture impossible : {e}"))?;
                    if !out.status.success() {
                        return Err("capture de la fenêtre refusée par macOS".to_string());
                    }
                    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
                    image::load_from_memory(&bytes).map_err(|e| e.to_string())
                })();
                let _ = std::fs::remove_file(&path);
                return encode(result?, max);
            }
            // Pas d'accès à la fenêtre (Accessibilité refusée) : l'écran entier.
        }
        #[cfg(not(target_os = "macos"))]
        let _ = &mode;
        encode(grab()?, max)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Capture l'écran et renvoie un JPEG base64 réduit à `max_width` (défaut 1280 px).
#[tauri::command]
pub fn capture_screen(max_width: Option<u32>) -> Result<ScreenCapture, String> {
    encode(grab()?, max_width.unwrap_or(1280))
}

// ===== Sélection d'une zone =====
//
// L'utilisateur ne veut pas toujours faire lire TOUT son écran : une erreur dans
// un coin, un tableau, un paragraphe. Envoyer l'écran entier dilue la question,
// et sur un modèle vision local la zone utile finit à quelques dizaines de
// pixels une fois l'image réduite à 1280 px.
//
// Le tracé se fait sur une capture DÉJÀ prise, affichée en plein écran : c'est
// la seule approche qui marche partout (aucun utilitaire système n'offre de
// sélection scriptable sur les trois plateformes), et elle garantit que la
// fenêtre de sélection elle-même ne figure pas sur l'image.
//
// La capture pleine résolution est gardée ici entre l'ouverture de la surface et
// le tracé : la recapturer au moment du recadrage donnerait l'écran d'APRÈS
// (surface de sélection comprise), et un rectangle tracé sur une image ne
// correspondant plus à rien.
#[derive(Default)]
pub struct PendingSelection(Mutex<Option<Pending>>);

pub struct Pending {
    image: image::DynamicImage,
    /// Fenêtre qui a demandé la sélection. Le résultat lui est renvoyé à ELLE
    /// seule : la barre Lumen et le bureau Lumen OS proposent tous deux
    /// « Comprendre cette zone », et une diffusion enverrait deux fois la même
    /// image à deux conversations différentes.
    requester: String,
}

const SELECT_LABEL: &str = "screen-select";

/// Capture l'écran puis ouvre la surface de sélection par-dessus.
///
/// La capture précède la création de la fenêtre, sans quoi la surface — opaque
/// le temps d'un rendu — se retrouverait sur l'image.
#[tauri::command]
pub fn screen_select_open(app: tauri::AppHandle, window: tauri::Window) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(win) = app.get_webview_window(SELECT_LABEL) {
        let _ = win.close();
    }
    let shot = grab()?;
    *app.state::<PendingSelection>()
        .0
        .lock()
        .map_err(|_| "sélection d'écran indisponible".to_string())? =
        Some(Pending { image: shot, requester: window.label().to_string() });
    // Fenêtre dimensionnée sur l'écran plutôt que `fullscreen(true)` : sous
    // macOS le vrai plein écran ouvre un Space, avec son animation d'une demi-
    // seconde — insupportable pour un geste qu'on répète, et l'utilisateur perd
    // de vue ce qu'il voulait justement montrer.
    let mut builder =
        WebviewWindowBuilder::new(&app, SELECT_LABEL, WebviewUrl::App("screen-select.html".into()))
            .title("Lumen — Sélection")
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            // Ni `maximized(true)` ni `fullscreen(true)` au moment du build :
            // la combinaison casse la création WebView2 sous Windows (fenêtre
            // blanche), cf. le même écueil sur `sandbox-explorer`. La taille
            // explicite ci-dessous couvre l'écran sans en passer par là.
            .resizable(false);
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        let pos = monitor.position().to_logical::<f64>(scale);
        builder = builder
            .inner_size(size.width, size.height)
            .position(pos.x, pos.y);
    }
    builder
        .build()
        .map_err(|e| format!("surface de sélection impossible : {e}"))?;
    Ok(())
}

/// Aperçu affiché par la surface de sélection (réduit : il ne sert qu'à viser).
#[tauri::command]
pub fn screen_select_preview(app: tauri::AppHandle) -> Result<ScreenCapture, String> {
    let state = app.state::<PendingSelection>();
    let guard = state
        .0
        .lock()
        .map_err(|_| "sélection d'écran indisponible".to_string())?;
    let pending = guard.as_ref().ok_or("aucune capture en attente")?;
    encode(pending.image.clone(), 1920)
}

/// Recadre la capture en attente et diffuse le résultat.
///
/// Les coordonnées sont NORMALISÉES (0..1) et rapportées à l'image affichée, pas
/// à la fenêtre : la surface montre la capture en `contain`, donc la zone utile
/// est letterboxée dès que l'écran capturé et la fenêtre n'ont pas le même
/// rapport — ce qui arrive systématiquement sur un bureau multi-écrans sous
/// Windows, où la capture couvre l'écran virtuel entier.
#[tauri::command]
pub fn screen_select_finish(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let state = app.state::<PendingSelection>();
    let pending = state
        .0
        .lock()
        .map_err(|_| "sélection d'écran indisponible".to_string())?
        .take()
        .ok_or("aucune capture en attente")?;
    let img = pending.image;
    if let Some(win) = app.get_webview_window(SELECT_LABEL) {
        let _ = win.close();
    }
    let (iw, ih) = (img.width() as f64, img.height() as f64);
    let px = (x.clamp(0.0, 1.0) * iw).round() as u32;
    let py = (y.clamp(0.0, 1.0) * ih).round() as u32;
    // Une sélection trop petite (clic involontaire, tremblement) donnerait une
    // vignette illisible : on refuse plutôt que d'envoyer 3 pixels au modèle.
    let pw = ((width.clamp(0.0, 1.0) * iw).round() as u32).min(img.width().saturating_sub(px));
    let ph = ((height.clamp(0.0, 1.0) * ih).round() as u32).min(img.height().saturating_sub(py));
    if pw < 16 || ph < 16 {
        return Err("zone sélectionnée trop petite".into());
    }
    let shot = encode(img.crop_imm(px, py, pw, ph), 1280)?;
    app.emit_to(pending.requester.as_str(), "screen-selection", shot)
        .map_err(|e| format!("sélection non transmise : {e}"))
}

/// Abandonne la sélection (Échap, clic droit, fermeture de la surface).
#[tauri::command]
pub fn screen_select_cancel(app: tauri::AppHandle) {
    if let Ok(mut guard) = app.state::<PendingSelection>().0.lock() {
        *guard = None;
    }
    if let Some(win) = app.get_webview_window(SELECT_LABEL) {
        let _ = win.close();
    }
}
