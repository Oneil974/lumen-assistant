//! Dossiers de données — **partagés par les deux éditions** de Lumen.
//!
//! Lumen et Lumen Pro sont deux applications distinctes : noms, icônes et
//! identifiants de bundle différents, pour que macOS (et Windows) les
//! reconnaissent comme deux logiciels, avec chacun son icône et sa place dans le
//! Dock. Mais elles doivent travailler sur LES MÊMES DONNÉES : les bases SQLite,
//! les sandboxes, les profils, la mémoire, les modèles téléchargés et les voix.
//!
//! Or `app_data_dir()` de Tauri dérive du **bundle identifier** : deux
//! identifiants = deux dossiers, donc deux vies parallèles. Ce module corrige ce
//! seul point : il prend le dossier calculé par Tauri et remplace son dernier
//! segment par un nom canonique. Tout le reste du chemin — conventions macOS,
//! Windows et Linux — reste celui de Tauri, qu'on ne cherche pas à réécrire.
//!
//! Conséquence assumée : le stockage de la WebView (localStorage) reste, lui,
//! propre à chaque identifiant sur macOS — il n'est pas redirigeable. Les
//! préférences d'interface (thème, modèle choisi) sont donc à refaire une fois
//! dans l'édition Pro ; aucune donnée utilisateur n'est concernée.

use std::path::PathBuf;
use tauri::path::PathResolver;
use tauri::Wry;

/// Nom du dossier de données, commun aux deux éditions. C'est l'identifiant
/// historique de Lumen : les installations existantes ne bougent pas d'un pouce.
pub const SHARED_DIR: &str = "com.lumen.app";

fn share(dir: PathBuf) -> PathBuf {
    match dir.parent() {
        Some(parent) => parent.join(SHARED_DIR),
        None => dir,
    }
}

/// `app_data_dir()`, ramené au dossier commun.
pub fn shared_data_dir(path: &PathResolver<Wry>) -> Result<PathBuf, tauri::Error> {
    path.app_data_dir().map(share)
}

/// `app_config_dir()`, ramené au dossier commun.
pub fn shared_config_dir(path: &PathResolver<Wry>) -> Result<PathBuf, tauri::Error> {
    path.app_config_dir().map(share)
}

/// `app_cache_dir()`, ramené au dossier commun (voix TTS, caches de modèles).
pub fn shared_cache_dir(path: &PathResolver<Wry>) -> Result<PathBuf, tauri::Error> {
    path.app_cache_dir().map(share)
}

/// `app_log_dir()`, ramené au dossier commun.
pub fn shared_log_dir(path: &PathResolver<Wry>) -> Result<PathBuf, tauri::Error> {
    path.app_log_dir().map(share)
}

#[cfg(test)]
mod tests {
    use super::{share, SHARED_DIR};
    use std::path::PathBuf;

    #[test]
    fn remplace_le_dernier_segment_par_le_dossier_commun() {
        let pro = PathBuf::from("/Users/x/Library/Application Support/com.lumen.pro");
        assert_eq!(
            share(pro),
            PathBuf::from(format!("/Users/x/Library/Application Support/{SHARED_DIR}")),
        );
    }

    #[test]
    fn laisse_l_edition_standard_ou_elle_est() {
        let std = PathBuf::from("/Users/x/Library/Application Support/com.lumen.app");
        assert_eq!(share(std.clone()), std, "aucune migration pour l'édition historique");
    }
}
