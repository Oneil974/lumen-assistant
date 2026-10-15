// Prevents additional console windows on Windows, including dev/debug builds.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    // Pont MCP stdio : ne démarre PAS l'interface, relaie stdin/stdout vers
    // le serveur MCP de l'instance de Lumen déjà lancée.
    if std::env::args().any(|a| a == "--mcp-stdio") {
        std::process::exit(tauri_app_lib::mcp_stdio_bridge());
    }
    // Linux : ⚠️ NE PAS désactiver le renderer DMABUF de WebKitGTK par défaut.
    // Testé : `WEBKIT_DISABLE_DMABUF_RENDERER=1` CASSE les couleurs de l'orbe
    // WebGL (three.js) ET ne répare PAS la transparence — celle-ci vient d'un
    // compositeur (picom sous X11), pas de cette variable.
    //
    // SAUF sur pilote NVIDIA propriétaire. Là, l'import DMABUF de WebKitGTK est
    // cassé côté pilote : la fenêtre traîne (rémanence, tuiles jamais
    // réeffacées), les ombres se peignent en noir et le rendu rame. C'est le cas
    // matériel pour lequel la porte de sortie existait ; on la franchit
    // automatiquement quand on reconnaît le pilote, plutôt que d'attendre que
    // l'utilisateur devine le nom d'une variable d'environnement.
    //
    // Priorité : `WEBKIT_DISABLE_DMABUF_RENDERER` posée par l'utilisateur gagne
    // toujours ; `LUMEN_DISABLE_DMABUF_RENDERER=1` force le repli sur n'importe
    // quel GPU, `=0` l'interdit même sur NVIDIA (pour retrouver les couleurs de
    // l'orbe si le pilote a été corrigé entre-temps).
    #[cfg(target_os = "linux")]
    {
        let forced = std::env::var("LUMEN_DISABLE_DMABUF_RENDERER").ok();
        let wanted = match forced.as_deref() {
            Some("1" | "true" | "TRUE" | "yes" | "YES") => true,
            Some("0" | "false" | "FALSE" | "no" | "NO") => false,
            _ => tauri_app_lib::linux_proprietary_nvidia(),
        };
        if wanted && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    tauri_app_lib::run()
}
