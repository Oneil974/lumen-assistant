//! Registre des applications et dépôt distant — le « store » de Lumen.
//!
//! Depuis la 0.2, Lumen n'embarque plus que son noyau : assistant, fichiers,
//! équipage, Fluxo, messagerie, mémoire, visite guidée, raccourcis, stockage,
//! paramètres, catalogue et documentation. Tout le reste — Muse, Tempo, Prisme,
//! Corpus, Arcade, Opus, Calc, Budget, Navigateur, les apps Pro… — est un
//! **paquet** téléchargé depuis un dépôt, installé dans le dossier de données,
//! et désinstallable.
//!
//! ## Ce qu'est un paquet
//!
//! Un fichier `.lumenapp` : une archive ZIP contenant un `manifest.json` à la
//! racine et les fichiers de l'app. Le manifeste déclare l'identité, le point
//! d'entrée et — surtout — les **capacités** demandées (cf. appperms.rs). Ce
//! qu'une app n'a pas déclaré là, elle ne pourra jamais l'obtenir : la liste est
//! figée au moment de l'installation, sous les yeux de l'utilisateur.
//!
//! ## Ce qui est vérifié, et ce qui ne l'est pas
//!
//! L'index du dépôt donne pour chaque paquet une empreinte SHA-256, comparée
//! après téléchargement : un paquet altéré en route est rejeté. Si le binaire
//! embarque une clé publique de dépôt, l'index lui-même doit être signé — sans
//! quoi quiconque contrôle le serveur (ou le DNS) choisirait ce que vous
//! installez. Sans clé configurée, on se contente du HTTPS et de l'empreinte, et
//! l'interface le dit franchement plutôt que d'afficher un cadenas mensonger.
//!
//! L'extraction refuse tout chemin absolu ou remontant (`../`) : une archive
//! hostile ne doit pas écrire hors de son dossier.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Dépôt par défaut. Surchargeable par l'utilisateur (réglage `repoUrl`) pour
/// héberger un catalogue interne d'entreprise.
const DEFAULT_REPO: &str = "https://oneil974.github.io/lumen-apps/index.json";

/// Clé **publique** du dépôt, base64url non paddé (32 octets), ou la valeur
/// sentinelle si ce build n'en embarque pas. Cf. `scripts/repo-sign.mjs`.
const REPO_PUBLIC_KEY: &str = "Vf3G5N4TVETGLihVaJH6BOPGN3UTgCG1BVi9aysV7X0";

/// Manifeste d'une application, tel qu'il figure dans le paquet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    /// Espace du menu démarrer (`create`, `organize`, `data`, `search`,
    /// `people`, `audio`, `comm`, `play`, `lab`).
    #[serde(default = "default_category")]
    pub category: String,
    /// Point d'entrée relatif à la racine du paquet.
    #[serde(default = "default_entry")]
    pub entry: String,
    /// Capacités demandées — la liste que voit l'utilisateur avant d'installer.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Dégradé de l'icône, deux couleurs CSS.
    #[serde(default)]
    pub gradient: Vec<String>,
    /// Nom d'icône Lucide, ou SVG inline.
    #[serde(default)]
    pub icon: String,
    /// Taille de fenêtre souhaitée.
    #[serde(default = "default_w")]
    pub width: u32,
    #[serde(default = "default_h")]
    pub height: u32,
    /// Ancien marqueur « édition Pro ». Ignoré depuis que les applications ne
    /// demandent plus de licence ; gardé pour lire les anciens manifestes.
    #[serde(default)]
    pub pro: bool,
    /// Pack facultatif dont l'app fait partie (`loisirs`, `robotique`, `ml`…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<String>,
    /// Prérequis annoncés avant l'installation (matériel, espace, dépendances).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prerequisites: Option<String>,
    /// Version minimale de Lumen requise.
    #[serde(default)]
    pub min_lumen: Option<String>,
    /// Niveau de confiance : `first-party` (paquet signé Lumen, commandes
    /// Tauri relayées) ou `third-party` (seul `window.lumen`). Doit traverser
    /// `app_list` intact : le bureau (`appkit/host.js`) le lit pour décider, et
    /// un champ absent vaut « tierce » — donc aucune commande brute, et toutes
    /// les apps historiques cassées à l'ouverture.
    #[serde(default = "default_trust")]
    pub trust: String,
    /// Onglets d'un paquet-hub (`{ id, name, hint, url }`). Transmis tels quels :
    /// c'est le shell du hub qui les interprète, Lumen ne fait que les relayer
    /// (l'hôte AppKit s'en sert pour accepter un id d'onglet comme destinataire).
    #[serde(default)]
    pub tabs: Vec<serde_json::Value>,
    /// App Intents : actions que l'app PROMEUT à l'assistant, déclarées dans
    /// le manifeste (`{ id, title, description, tab?, parameters?, required? }`).
    /// Lumen les expose comme outils au modèle même quand l'app est fermée —
    /// il l'ouvre alors et lui remet l'intention.
    #[serde(default)]
    pub intents: Vec<serde_json::Value>,
    /// Lumen XR : vues que l'app propose dans le casque (`{ views: [idIntent],
    /// detail?: { intent, arg } }`). Facultatif : sans lui, le casque déduit
    /// les vues des intentions de consultation (list_…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xr: Option<serde_json::Value>,
}

fn default_category() -> String { "create".into() }
fn default_entry() -> String { "index.html".into() }
fn default_w() -> u32 { 1120 }
fn default_h() -> u32 { 780 }
fn default_trust() -> String { "third-party".into() }

/// Entrée de l'index du dépôt : le manifeste, plus de quoi aller chercher et
/// vérifier le paquet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    #[serde(flatten)]
    pub manifest: Manifest,
    /// URL du `.lumenapp`, absolue ou relative à l'index.
    pub url: String,
    /// Empreinte SHA-256 du paquet, en hexadécimal minuscule.
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
    /// Révision du contenu (incrémentée à chaque publication où un fichier change).
    #[serde(default)]
    pub rev: u32,
    /// Date (ISO) de la dernière révision du contenu.
    #[serde(default)]
    pub updated: Option<String>,
    /// Résumé des changements de cette révision, affiché dans « Mises à jour ».
    #[serde(default)]
    pub changes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIndex {
    #[serde(default)]
    pub apps: Vec<RepoEntry>,
    /// Signature Ed25519 de l'index, base64url. Absente = dépôt non signé.
    #[serde(default)]
    pub signature: Option<String>,
}

/// Ce que l'interface reçoit pour une app installée.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    #[serde(flatten)]
    pub manifest: Manifest,
    pub installed_at: i64,
}

fn apps_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path())
        .map_err(|e| format!("dossier de données introuvable : {e}"))?
        .join("apps");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Valide un identifiant d'app avant de le transformer en nom de dossier.
/// C'est ici que se joue la sécurité des chemins : `..`, `/` ou un id vide
/// deviendraient sinon une écriture n'importe où sur le disque.
fn safe_id(id: &str) -> Result<&str, String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(id) } else { Err(format!("identifiant d'application invalide : {id}")) }
}

fn app_dir(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(apps_dir(app)?.join(safe_id(id)?))
}

fn read_manifest(dir: &Path) -> Option<Manifest> {
    let raw = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Applications RETIRÉES de Lumen. Leur code a quitté le dépôt, mais une copie
/// installée survit dans le dossier de données de chaque machine (et l'index
/// en cache peut encore les citer) : sans ce ménage, une app supprimée reste
/// au bureau indéfiniment. Elles sont désinstallées à la première lecture de la
/// liste, masquées du Catalogue et refusées à l'installation. Leurs DONNÉES
/// (sandbox `app:<id>`) ne sont pas touchées, comme pour une désinstallation.
///   - `living` : « Discussion vivante », remplacée par Luciole (08/10/2026) ;
///   - `reporting` : fusionnée dans « Analyse de données » (08/10/2026).
pub const RETIRED_APPS: &[&str] = &["living", "reporting"];

fn purge_retired(app: &tauri::AppHandle) {
    for id in RETIRED_APPS {
        let Ok(dir) = app_dir(app, id) else { continue };
        if !dir.join("manifest.json").exists() {
            continue;
        }
        if std::fs::remove_dir_all(&dir).is_ok() {
            let _ = crate::appperms::perm_reset(app.clone(), (*id).to_string());
            eprintln!("[appstore] app retirée désinstallée : {id}");
        }
    }
}

/// Applications installées, triées par nom.
#[tauri::command]
pub fn app_list(app: tauri::AppHandle) -> Result<Vec<InstalledApp>, String> {
    purge_retired(&app);
    let dir = apps_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(manifest) = read_manifest(&path) {
            let installed_at = std::fs::metadata(path.join("manifest.json"))
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push(InstalledApp { manifest, installed_at });
        }
    }
    out.sort_by(|a, b| a.manifest.name.to_lowercase().cmp(&b.manifest.name.to_lowercase()));
    Ok(out)
}

/// URL du dépôt configuré.
#[tauri::command]
pub fn store_repo_url(app: tauri::AppHandle) -> String {
    std::fs::read_to_string(repo_setting_path(&app).unwrap_or_default())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_REPO.to_string())
}

fn repo_setting_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_config_dir(app.path()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("app-repo.txt"))
}

/// Change le dépôt. Refuse tout ce qui n'est pas HTTPS : un index en clair se
/// réécrit en route, et il décide de ce qui s'installe sur la machine.
#[tauri::command]
pub fn store_set_repo(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let url = url.trim().to_string();
    let target = if url.is_empty() { DEFAULT_REPO.to_string() } else { url };
    if !target.starts_with("https://") {
        return Err("le dépôt doit être servi en HTTPS".into());
    }
    std::fs::write(repo_setting_path(&app)?, &target).map_err(|e| e.to_string())?;
    Ok(target)
}

fn index_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(apps_dir(app)?.join("_index.json"))
}

/// Forme canonique signée : une ligne `id|version|sha256` par application,
/// triée par identifiant. Reconstruite à l'identique par `scripts/repo-sign.mjs`
/// — c'est le seul point où les deux implémentations doivent s'accorder, et il
/// est assez petit pour qu'on puisse en être sûr.
fn canonical_form(apps: &[RepoEntry]) -> String {
    let mut lines: Vec<String> = apps
        .iter()
        .map(|e| format!("{}|{}|{}", e.manifest.id, e.manifest.version, e.sha256.to_lowercase()))
        .collect();
    lines.sort();
    lines.join("\n")
}

fn verify_index_signature(apps: &[RepoEntry], signature: Option<&str>) -> Result<bool, String> {
    if REPO_PUBLIC_KEY == "REPLACE_WITH_REPO_PUBLIC_KEY" {
        // Pas de clé embarquée : on ne prétend pas vérifier. L'appelant affiche
        // « dépôt non vérifié », ce qui est la vérité.
        return Ok(false);
    }
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let sig = signature.ok_or("l'index du dépôt n'est pas signé")?;
    let key_bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(REPO_PUBLIC_KEY)
        .map_err(|_| "clé de dépôt illisible".to_string())?
        .as_slice()
        .try_into()
        .map_err(|_| "clé de dépôt invalide".to_string())?;
    let sig_bytes: [u8; 64] = URL_SAFE_NO_PAD
        .decode(sig)
        .map_err(|_| "signature du dépôt illisible".to_string())?
        .as_slice()
        .try_into()
        .map_err(|_| "signature du dépôt invalide".to_string())?;
    VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| "clé de dépôt invalide".to_string())?
        .verify(canonical_form(apps).as_bytes(), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| "signature du dépôt invalide — index rejeté".to_string())?;
    Ok(true)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreIndex {
    pub apps: Vec<RepoEntry>,
    /// Vrai si la signature du dépôt a été vérifiée avec la clé embarquée.
    pub verified: bool,
    pub repo: String,
    /// Vrai si l'index vient du cache disque faute de réseau.
    pub offline: bool,
}

/// Index du dépôt. Sans réseau, rend le dernier index connu plutôt qu'une
/// erreur : le Catalogue reste consultable, et l'installation échouera d'elle-
/// même au téléchargement, avec un message clair.
#[tauri::command]
pub async fn store_index(app: tauri::AppHandle, refresh: Option<bool>) -> Result<StoreIndex, String> {
    let repo = store_repo_url(app.clone());
    let cache = index_cache_path(&app)?;

    if refresh != Some(true) {
        if let Ok(raw) = std::fs::read_to_string(&cache) {
            if let Ok(parsed) = serde_json::from_str::<RepoIndex>(&raw) {
                let verified = verify_index_signature(&parsed.apps, parsed.signature.as_deref()).unwrap_or(false);
                return Ok(StoreIndex { apps: without_retired(parsed.apps), verified, repo, offline: false });
            }
        }
    }

    let url = repo.clone();
    let fetched = tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("dépôt injoignable (HTTP {})", resp.status()));
        }
        resp.text().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    match fetched {
        Ok(body) => {
            let parsed: RepoIndex = serde_json::from_str(&body)
                .map_err(|e| format!("index du dépôt illisible : {e}"))?;
            // Une signature PRÉSENTE mais fausse est une erreur dure : on ne
            // garde même pas l'index en cache.
            let verified = match verify_index_signature(&parsed.apps, parsed.signature.as_deref()) {
                Ok(v) => v,
                Err(e) if parsed.signature.is_some() => return Err(e),
                Err(_) => false,
            };
            let _ = std::fs::write(&cache, &body);
            Ok(StoreIndex { apps: without_retired(parsed.apps), verified, repo, offline: false })
        }
        Err(net_err) => {
            let raw = std::fs::read_to_string(&cache)
                .map_err(|_| format!("{net_err} — et aucun index en cache"))?;
            let parsed: RepoIndex = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            let verified = verify_index_signature(&parsed.apps, parsed.signature.as_deref()).unwrap_or(false);
            Ok(StoreIndex { apps: without_retired(parsed.apps), verified, repo, offline: true })
        }
    }
}

/// L'index est filtré APRÈS vérification de sa signature (qui porte sur
/// l'ensemble publié) : on ne fait que masquer, jamais réécrire.
fn without_retired(apps: Vec<RepoEntry>) -> Vec<RepoEntry> {
    apps.into_iter().filter(|e| !RETIRED_APPS.contains(&e.manifest.id.as_str())).collect()
}

fn absolutize(repo: &str, url: &str) -> String {
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.to_string();
    }
    match repo.rfind('/') {
        Some(i) => format!("{}/{}", &repo[..i], url.trim_start_matches('/')),
        None => url.to_string(),
    }
}

/// Télécharge, vérifie et installe une application.
///
/// L'installation est atomique du point de vue de l'utilisateur : on extrait
/// dans un dossier temporaire, et on ne remplace l'ancienne version qu'une fois
/// l'extraction terminée. Une mise à jour interrompue laisse donc l'app
/// précédente en état de marche, pas un dossier à moitié écrit.
#[tauri::command]
pub async fn app_install(app: tauri::AppHandle, id: String) -> Result<Manifest, String> {
    safe_id(&id)?;
    if RETIRED_APPS.contains(&id.as_str()) {
        return Err(format!("« {id} » a été retirée de Lumen"));
    }
    // Index FRAIS, pas celui du cache : entre deux ouvertures du Catalogue, le
    // dépôt a pu republier ses paquets, et une empreinte périmée ferait
    // refuser un paquet parfaitement sain (« ne correspond pas à son
    // empreinte »). Sans réseau, store_index retombe de lui-même sur le cache.
    let index = store_index(app.clone(), Some(true)).await?;
    let entry = index
        .apps
        .into_iter()
        .find(|e| e.manifest.id == id)
        .ok_or_else(|| format!("« {id} » ne figure pas dans le dépôt"))?;

    let url = absolutize(&index.repo, &entry.url);
    let expected = entry.sha256.to_lowercase();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("téléchargement impossible (HTTP {})", resp.status()));
        }
        resp.bytes().map(|b| b.to_vec()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    if !expected.is_empty() && sha256_hex(&bytes) != expected {
        return Err("le paquet téléchargé ne correspond pas à son empreinte — installation annulée".into());
    }

    let dest = app_dir(&app, &id)?;
    let staging = dest.with_extension("installing");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    extract(&bytes, &staging).inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&staging);
    })?;

    let manifest = read_manifest(&staging).ok_or_else(|| {
        let _ = std::fs::remove_dir_all(&staging);
        "paquet sans manifest.json lisible".to_string()
    })?;
    if manifest.id != id {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!(
            "le paquet dit s'appeler « {} » alors que le dépôt le référence comme « {id} »",
            manifest.id
        ));
    }

    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&staging, &dest).map_err(|e| format!("installation impossible : {e}"))?;
    let _ = tauri::Emitter::emit(&app, "lumen-apps-changed", serde_json::json!({ "id": id }));
    Ok(manifest)
}

/// Extrait une archive `.lumenapp`. Refuse les chemins absolus et les
/// remontées : une archive ne doit écrire que sous `root`.
fn extract(bytes: &[u8], root: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("archive illisible : {e}"))?;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
        // `enclosed_name` rend `None` pour tout chemin qui sortirait du dossier :
        // c'est exactement le contrôle qu'on veut, et il vaut mieux que le nôtre.
        let Some(rel) = file.enclosed_name() else {
            return Err(format!("chemin refusé dans l'archive : {}", file.name()));
        };
        let target = root.join(rel);
        if file.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&target, buf).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Désinstalle une application et oublie tout ce qu'elle avait obtenu.
///
/// Les DONNÉES de l'app (sa sandbox `app:<id>`) ne sont pas touchées : quelqu'un
/// qui désinstalle pour faire de la place ne s'attend pas à perdre ses notes.
/// Le ménage complet se fait depuis l'app Stockage, où c'est dit explicitement.
#[tauri::command]
pub fn app_uninstall(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = app_dir(&app, &id)?;
    if !dir.exists() {
        return Err(format!("« {id} » n'est pas installée"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("désinstallation impossible : {e}"))?;
    let _ = crate::appperms::perm_reset(app.clone(), id.clone());
    let _ = tauri::Emitter::emit(&app, "lumen-apps-changed", serde_json::json!({ "id": id }));
    Ok(())
}

/// Contenu d'un fichier du paquet, pour que le shell puisse le servir à
/// l'iframe. Confiné au dossier de l'app par `enclosed`-comme contrôle.
#[tauri::command]
pub fn app_asset(app: tauri::AppHandle, id: String, path: String) -> Result<Vec<u8>, String> {
    let root = app_dir(&app, &id)?;
    let target = root.join(path.trim_start_matches('/'));
    let canonical = target
        .canonicalize()
        .map_err(|_| format!("fichier introuvable : {path}"))?;
    let root_canonical = root.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root_canonical) {
        return Err("chemin hors du paquet".into());
    }
    std::fs::read(&canonical).map_err(|e| e.to_string())
}

/// Applications installées dont le dépôt propose une version différente.
#[tauri::command]
pub async fn app_updates(app: tauri::AppHandle) -> Result<Vec<RepoEntry>, String> {
    let installed = app_list(app.clone())?;
    let index = store_index(app, Some(true)).await?;
    Ok(index
        .apps
        .into_iter()
        .filter(|entry| {
            installed
                .iter()
                .any(|i| i.manifest.id == entry.manifest.id && i.manifest.version != entry.manifest.version)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{absolutize, safe_id};

    #[test]
    fn identifiants_refuses() {
        assert!(safe_id("notes").is_ok());
        assert!(safe_id("data-analysis").is_ok());
        assert!(safe_id("..").is_err());
        assert!(safe_id("a/b").is_err());
        assert!(safe_id("").is_err());
    }

    #[test]
    fn urls_relatives_au_depot() {
        let repo = "https://exemple.org/lumen/index.json";
        assert_eq!(absolutize(repo, "packs/notes.lumenapp"), "https://exemple.org/lumen/packs/notes.lumenapp");
        assert_eq!(absolutize(repo, "https://ailleurs/x.lumenapp"), "https://ailleurs/x.lumenapp");
    }
}
