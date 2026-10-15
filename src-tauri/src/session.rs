//! Verrouillage de session Lumen OS.
//!
//! Le mot de passe de l'écran de connexion est vérifié CÔTÉ RUST : le hash
//! salé (SHA-256) vit dans `app_data_dir/session_lock.json`, hors de portée
//! des webviews (pas de localStorage). Le bureau ne monte son shell qu'après
//! un `session_unlock` réussi — le contenu n'est donc ni affiché ni construit
//! derrière l'écran de connexion.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

#[derive(Default, Serialize, Deserialize)]
struct LockConfig {
    enabled: bool,
    /// Sel aléatoire (hex) + hash hex de SHA-256(sel || mot de passe).
    #[serde(default)]
    salt: String,
    #[serde(default)]
    hash: String,
    /// Algorithme de hash. Vide = ancien SHA-256 simple, conservé pour migration.
    #[serde(default)]
    algo: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub salt: String,
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub algo: String,
    /// Badge RFID lié au profil. L'UID est haché AVEC SEL comme un mot de
    /// passe : un vol du fichier de profils ne livre donc pas l'identifiant
    /// du badge. Cela ne rend pas l'UID secret pour autant — une carte le
    /// diffuse en clair et se clone — c'est un facteur de commodité, à la
    /// manière d'une clé physique, pas un équivalent du mot de passe.
    #[serde(default)]
    pub rfid_salt: String,
    #[serde(default)]
    pub rfid_hash: String,
    #[serde(default)]
    pub legacy_workspace: bool,
}

#[derive(Serialize)]
pub struct PublicUserProfile {
    id: String,
    name: String,
    avatar: String,
    enabled: bool,
    has_password: bool,
    has_rfid: bool,
    legacy_workspace: bool,
}

impl From<&UserProfile> for PublicUserProfile {
    fn from(p: &UserProfile) -> Self {
        Self {
            id: p.id.clone(),
            name: p.name.clone(),
            avatar: p.avatar.clone(),
            enabled: p.enabled,
            has_password: profile_has_password(p),
            has_rfid: !p.rfid_hash.is_empty(),
            legacy_workspace: p.legacy_workspace,
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct ProfileStore {
    active_id: String,
    profiles: Vec<UserProfile>,
}

#[derive(Default)]
struct Runtime {
    unlocked: bool,
    failed_attempts: u32,
    blocked_until: Option<Instant>,
    /// Autorisation PONCTUELLE de configuration (ex. changer la sandbox d'un
    /// agent) accordée par mot de passe alors que le bureau reste verrouillé.
    /// Courte (5 min) et jamais persistée.
    config_grant_until: Option<Instant>,
}

#[derive(Default)]
pub struct SessionState {
    runtime: Mutex<Runtime>,
}

const HASH_ROUNDS: u32 = 120_000;

fn lock_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session_lock.json"))
}

fn profiles_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session_profiles.json"))
}

fn read_config(app: &tauri::AppHandle) -> LockConfig {
    lock_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn make_profile_id(name: &str) -> String {
    let base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let base = if base.is_empty() {
        "profil".into()
    } else {
        base
    };
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{base}-{suffix}")
}

fn default_profile_from_legacy(app: &tauri::AppHandle) -> UserProfile {
    let legacy = read_config(app);
    UserProfile {
        id: "default".into(),
        name: "Utilisateur".into(),
        avatar: String::new(),
        enabled: legacy.enabled,
        salt: legacy.salt,
        hash: legacy.hash,
        algo: legacy.algo,
        rfid_salt: String::new(),
        rfid_hash: String::new(),
        legacy_workspace: true,
    }
}

fn normalize_profiles(app: &tauri::AppHandle, mut store: ProfileStore) -> ProfileStore {
    let legacy = read_config(app);
    store.profiles.retain(|p| !p.id.trim().is_empty());
    if store.profiles.is_empty() {
        store.profiles.push(default_profile_from_legacy(app));
    }
    if !store.profiles.iter().any(|p| p.legacy_workspace) {
        if let Some(first) = store.profiles.first_mut() {
            first.legacy_workspace = true;
        }
    }
    for p in &mut store.profiles {
        if p.id == "default" {
            p.legacy_workspace = true;
        }
        if p.legacy_workspace && p.hash.is_empty() && !legacy.hash.is_empty() {
            p.enabled = legacy.enabled;
            p.salt = legacy.salt.clone();
            p.hash = legacy.hash.clone();
            p.algo = legacy.algo.clone();
        }
    }
    if store.active_id.is_empty() || !store.profiles.iter().any(|p| p.id == store.active_id) {
        store.active_id = store.profiles[0].id.clone();
    }
    store
}

fn read_profiles(app: &tauri::AppHandle) -> ProfileStore {
    profiles_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .map(|store| normalize_profiles(app, store))
        .unwrap_or_else(|| normalize_profiles(app, ProfileStore::default()))
}

fn write_profiles(app: &tauri::AppHandle, store: &ProfileStore) -> Result<(), String> {
    let p = profiles_path(app)?;
    fs::write(
        &p,
        serde_json::to_string_pretty(store).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn active_profile(app: &tauri::AppHandle) -> UserProfile {
    let store = read_profiles(app);
    store
        .profiles
        .iter()
        .find(|p| p.id == store.active_id)
        .cloned()
        .unwrap_or_else(|| default_profile_from_legacy(app))
}

fn profile_has_password(p: &UserProfile) -> bool {
    !p.hash.is_empty()
}

fn verify_profile_password(p: &UserProfile, password: &str) -> bool {
    if !p.enabled || p.hash.is_empty() {
        return true;
    }
    let cfg = LockConfig {
        enabled: p.enabled,
        salt: p.salt.clone(),
        hash: p.hash.clone(),
        algo: p.algo.clone(),
    };
    verify_password(&cfg, password)
}

fn require_current_password(
    profile: &UserProfile,
    current_password: Option<String>,
) -> Result<(), String> {
    if !profile.enabled || profile.hash.is_empty() {
        return Ok(());
    }
    let Some(password) = current_password else {
        return Err("Mot de passe actuel requis.".into());
    };
    if verify_profile_password(profile, &password) {
        Ok(())
    } else {
        Err("Mot de passe actuel incorrect.".into())
    }
}

fn hash_password_legacy(salt: &str, password: &str) -> String {
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(password.as_bytes());
    format!("{:x}", h.finalize())
}

fn hash_password(salt: &str, password: &str) -> String {
    let mut digest = hash_password_legacy(salt, password).into_bytes();
    for _ in 1..HASH_ROUNDS {
        let mut h = Sha256::new();
        h.update(salt.as_bytes());
        h.update(&digest);
        digest = format!("{:x}", h.finalize()).into_bytes();
    }
    String::from_utf8(digest).unwrap_or_default()
}

fn verify_password(cfg: &LockConfig, password: &str) -> bool {
    if cfg.algo == "sha256-iter-v1" {
        hash_password(&cfg.salt, password) == cfg.hash
    } else {
        hash_password_legacy(&cfg.salt, password) == cfg.hash
    }
}

fn random_salt() -> String {
    let mut buf = [0u8; 16];
    let _ = getrandom::getrandom(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// État du verrouillage : `{ enabled, has_password, has_rfid }`.
/// Ne renvoie jamais le hachage du badge, seulement sa présence.
#[tauri::command]
pub fn session_lock_status(app: tauri::AppHandle) -> serde_json::Value {
    let p = active_profile(&app);
    serde_json::json!({
        "enabled": p.enabled,
        "has_password": profile_has_password(&p),
        "has_rfid": !p.rfid_hash.is_empty(),
        "profile_id": p.id,
        "profile_name": p.name,
        "avatar": p.avatar,
    })
}

/// `true` si les commandes protégées peuvent s'exécuter.
pub fn is_unlocked(app: &tauri::AppHandle, state: &SessionState) -> bool {
    let p = active_profile(app);
    if !p.enabled || p.hash.is_empty() {
        return true;
    }
    state.runtime.lock().map(|r| r.unlocked).unwrap_or(false)
}

/// Identité publique d'un profil, telle que l'écran de connexion du compagnon
/// doit pouvoir l'afficher : le nom et l'avatar, jamais le hash du mot de passe.
#[derive(Clone, Serialize)]
pub struct ProfileIdentity {
    pub id: String,
    pub name: String,
    pub avatar: String,
}

impl From<&UserProfile> for ProfileIdentity {
    fn from(p: &UserProfile) -> Self {
        Self {
            id: p.id.clone(),
            name: p.name.clone(),
            avatar: p.avatar.clone(),
        }
    }
}

/// Tous les profils, pour les modules qui doivent leur attacher quelque chose
/// (le compagnon leur donne à chacun son propre secret TOTP).
pub fn profile_identities(app: &tauri::AppHandle) -> Vec<ProfileIdentity> {
    read_profiles(app)
        .profiles
        .iter()
        .map(ProfileIdentity::from)
        .collect()
}

/// Replie les accents et la casse. « andre » doit retrouver « André » :
/// personne ne tape ses accents dans un champ de connexion sur un téléphone.
pub fn fold(raw: &str) -> String {
    raw.trim()
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'à' | 'â' | 'ä' | 'á' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' | 'í' | 'ì' => 'i',
            'ô' | 'ö' | 'ó' | 'ò' | 'õ' => 'o',
            'ù' | 'û' | 'ü' | 'ú' => 'u',
            'ÿ' | 'ý' => 'y',
            'ç' => 'c',
            'ñ' => 'n',
            other => other,
        })
        .collect()
}

/// Retrouve un profil par son NOM (ce que la personne tape), à défaut par son
/// identifiant technique. Insensible à la casse, aux accents et aux espaces de
/// bord.
pub fn find_profile_identity(app: &tauri::AppHandle, needle: &str) -> Option<ProfileIdentity> {
    let needle = fold(needle);
    if needle.is_empty() {
        return None;
    }
    let store = read_profiles(app);
    store
        .profiles
        .iter()
        .find(|p| fold(&p.name) == needle)
        .or_else(|| store.profiles.iter().find(|p| fold(&p.id) == needle))
        .map(ProfileIdentity::from)
}

fn profile_by_id(app: &tauri::AppHandle, profile_id: &str) -> Option<UserProfile> {
    read_profiles(app).profiles.into_iter().find(|p| p.id == profile_id)
}

/// Empreinte du mot de passe de session d'un profil, `None` s'il n'en a pas
/// (verrou désactivé). Le compagnon la mêle à la signature de ses jetons :
/// changer ou retirer le mot de passe invalide les téléphones connectés.
pub fn profile_password_binding(app: &tauri::AppHandle, profile_id: &str) -> Option<String> {
    profile_by_id(app, profile_id)
        .filter(|p| p.enabled && !p.hash.is_empty())
        .map(|p| format!("{}:{}", p.algo, p.hash))
}

/// Vérifie le mot de passe de session d'un profil (connexion du compagnon).
/// Faux pour un profil sans mot de passe : l'appelant ne doit pas demander.
pub fn check_profile_password(app: &tauri::AppHandle, profile_id: &str, password: &str) -> bool {
    match profile_by_id(app, profile_id) {
        Some(p) if p.enabled && !p.hash.is_empty() => verify_profile_password(&p, password),
        _ => false,
    }
}

pub fn active_profile_id(app: &tauri::AppHandle) -> String {
    active_profile(app).id
}

pub fn active_profile_uses_legacy_workspace(app: &tauri::AppHandle) -> bool {
    active_profile(app).legacy_workspace
}

#[tauri::command]
pub fn session_active_profile_id(app: tauri::AppHandle) -> String {
    active_profile_id(&app)
}

#[tauri::command]
pub fn session_profiles(app: tauri::AppHandle) -> serde_json::Value {
    let store = read_profiles(&app);
    let profiles: Vec<PublicUserProfile> =
        store.profiles.iter().map(PublicUserProfile::from).collect();
    serde_json::json!({ "active_id": store.active_id, "profiles": profiles })
}

#[tauri::command]
pub fn session_save_profile(
    app: tauri::AppHandle,
    id: Option<String>,
    name: String,
    avatar: Option<String>,
) -> Result<PublicUserProfile, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Nom de profil requis.".into());
    }
    let mut store = read_profiles(&app);
    let id = id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| make_profile_id(name));
    let mut profile = store
        .profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .unwrap_or(UserProfile {
            id: id.clone(),
            name: name.to_string(),
            avatar: String::new(),
            enabled: false,
            salt: String::new(),
            hash: String::new(),
            algo: String::new(),
            rfid_salt: String::new(),
            rfid_hash: String::new(),
            legacy_workspace: false,
        });
    profile.name = name.to_string();
    profile.avatar = avatar.unwrap_or_default();
    if let Some(existing) = store.profiles.iter_mut().find(|p| p.id == id) {
        *existing = profile.clone();
    } else {
        store.profiles.push(profile.clone());
    }
    if store.active_id.is_empty() {
        store.active_id = id;
    }
    write_profiles(&app, &normalize_profiles(&app, store))?;
    Ok(PublicUserProfile::from(&profile))
}

#[tauri::command]
pub fn session_set_active_profile(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionState>,
    id: String,
) -> Result<(), String> {
    let mut store = read_profiles(&app);
    if !store.profiles.iter().any(|p| p.id == id) {
        return Err("Profil introuvable.".into());
    }
    store.active_id = id;
    write_profiles(&app, &store)?;
    // La passerelle Telegram est propre au profil : on bascule sa boucle et on
    // vide son état en mémoire pour ne pas mélanger les conversations.
    crate::telegram::on_profile_switch(&app);
    crate::slack::on_profile_switch(&app);
    if let Ok(mut r) = state.runtime.lock() {
        r.unlocked = false;
        r.failed_attempts = 0;
        r.blocked_until = None;
    }
    Ok(())
}

#[tauri::command]
pub fn session_delete_profile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut store = read_profiles(&app);
    if store.profiles.len() <= 1 {
        return Err("Impossible de supprimer le dernier profil.".into());
    }
    store.profiles.retain(|p| p.id != id);
    // Les données Telegram de ce profil (jeton du bot, conversations autorisées,
    // transcrits) n'ont plus de propriétaire : on ne les laisse pas sur le disque.
    if let Ok(dir) = crate::paths::shared_data_dir(app.path()) {
        let _ = std::fs::remove_dir_all(dir.join("profiles").join(&id).join("telegram"));
        let _ = std::fs::remove_dir_all(dir.join("profiles").join(&id).join("slack"));
    }
    write_profiles(&app, &normalize_profiles(&app, store))
}

pub fn require_unlocked(app: &tauri::AppHandle, state: &SessionState) -> Result<(), String> {
    if is_unlocked(app, state) {
        Ok(())
    } else {
        Err("Session Lumen OS verrouillée.".into())
    }
}

/// La configuration sensible est-elle permise ? Session ouverte, ou
/// autorisation ponctuelle encore valide (`session_authorize_config`).
pub fn config_allowed(app: &tauri::AppHandle, state: &SessionState) -> bool {
    is_unlocked(app, state)
        || state
            .runtime
            .lock()
            .map(|r| r.config_grant_until.map(|t| Instant::now() < t).unwrap_or(false))
            .unwrap_or(false)
}

/// Vérifie le mot de passe du profil actif pour une action de configuration,
/// SANS déverrouiller le bureau : on peut régler un agent depuis la barre
/// alors que Lumen OS reste fermé. Mêmes garde-fous que `session_unlock`
/// (5 échecs → 30 s de blocage).
#[tauri::command]
pub fn session_authorize_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionState>,
    password: String,
) -> Result<(), String> {
    let p = active_profile(&app);
    {
        let r = state.runtime.lock().map_err(|_| "Session indisponible.")?;
        if r.blocked_until.map(|t| Instant::now() < t).unwrap_or(false) {
            return Err("Trop d'essais : patiente 30 secondes.".into());
        }
    }
    let ok = verify_profile_password(&p, &password);
    crate::devices::log("config-local", &p.id, None, "", ok, if ok { "" } else { "mot de passe refusé" });
    let mut r = state.runtime.lock().map_err(|_| "Session indisponible.")?;
    if ok {
        r.failed_attempts = 0;
        r.blocked_until = None;
        r.config_grant_until = Some(Instant::now() + Duration::from_secs(300));
        Ok(())
    } else {
        r.failed_attempts = r.failed_attempts.saturating_add(1);
        if r.failed_attempts >= 5 {
            r.blocked_until = Some(Instant::now() + Duration::from_secs(30));
        }
        Err("Mot de passe incorrect.".into())
    }
}

#[tauri::command]
pub fn session_is_unlocked(app: tauri::AppHandle, state: tauri::State<'_, SessionState>) -> bool {
    is_unlocked(&app, state.inner())
}

/// Active/désactive la demande de mot de passe à l'ouverture de Lumen OS.
#[tauri::command]
pub fn session_set_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionState>,
    enabled: bool,
    current_password: Option<String>,
) -> Result<(), String> {
    let mut store = read_profiles(&app);
    let profile = store
        .profiles
        .iter_mut()
        .find(|p| p.id == store.active_id)
        .ok_or_else(|| "Profil introuvable.".to_string())?;
    if !enabled {
        require_current_password(profile, current_password)?;
        if let Ok(mut r) = state.runtime.lock() {
            r.unlocked = true;
            r.failed_attempts = 0;
            r.blocked_until = None;
        }
    }
    profile.enabled = enabled;
    write_profiles(&app, &store)
}

/// Définit (ou remplace) le mot de passe de session.
#[tauri::command]
pub fn session_set_password(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionState>,
    password: String,
    current_password: Option<String>,
) -> Result<(), String> {
    if password.trim().is_empty() {
        return Err("Mot de passe vide.".into());
    }
    let mut store = read_profiles(&app);
    let profile = store
        .profiles
        .iter_mut()
        .find(|p| p.id == store.active_id)
        .ok_or_else(|| "Profil introuvable.".to_string())?;
    require_current_password(profile, current_password)?;
    profile.salt = random_salt();
    profile.hash = hash_password(&profile.salt, &password);
    profile.algo = "sha256-iter-v1".into();
    profile.enabled = true;
    if let Ok(mut r) = state.runtime.lock() {
        r.unlocked = false;
        r.failed_attempts = 0;
        r.blocked_until = None;
    }
    write_profiles(&app, &store)
}

/// Retire le mot de passe (l'écran de connexion redevient un simple clic).
#[tauri::command]
pub fn session_clear_password(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionState>,
    current_password: Option<String>,
) -> Result<(), String> {
    let mut store = read_profiles(&app);
    let profile = store
        .profiles
        .iter_mut()
        .find(|p| p.id == store.active_id)
        .ok_or_else(|| "Profil introuvable.".to_string())?;
    require_current_password(profile, current_password)?;
    profile.salt.clear();
    profile.hash.clear();
    profile.algo.clear();
    profile.enabled = false;
    if let Ok(mut r) = state.runtime.lock() {
        r.unlocked = true;
        r.failed_attempts = 0;
        r.blocked_until = None;
    }
    write_profiles(&app, &store)
}

/// Normalise un UID de badge : majuscules, sans séparateur. Les lecteurs et
/// les utilitaires l'écrivent tantôt `04a2b3c4`, tantôt `04:A2:B3:C4`.
fn normalize_uid(uid: &str) -> String {
    uid.chars()
        .filter(|c| c.is_ascii_hexdigit())
        .flat_map(|c| c.to_uppercase())
        .collect()
}

/// Ce badge ouvre-t-il déjà une session ?
///
/// Un badge a UN seul usage : ouvrir une session OU déclencher une action.
/// Sans cette règle, poser un badge d'authentification pendant une session
/// ouverte y déclencherait aussi un changement de modèle, et le geste
/// « ouvrir ma session » deviendrait imprévisible. `rfid_store` s'en sert pour
/// refuser d'associer une action à un badge d'ouverture de session.
pub fn uid_opens_session(app: &tauri::AppHandle, uid: &str) -> bool {
    let uid = normalize_uid(uid);
    if uid.len() < 6 {
        return false;
    }
    read_profiles(app)
        .profiles
        .iter()
        .any(|p| !p.rfid_hash.is_empty() && hash_password(&p.rfid_salt, &uid) == p.rfid_hash)
}

/// Lie un badge RFID au profil actif.
///
/// Le mot de passe courant est exigé, exactement comme pour le changer : sans
/// cela, quiconque a la main sur une session déjà ouverte pourrait s'ajouter
/// discrètement un badge d'accès permanent.
#[tauri::command]
pub fn session_set_rfid(
    app: tauri::AppHandle,
    uid: String,
    current_password: Option<String>,
) -> Result<(), String> {
    let uid = normalize_uid(&uid);
    if uid.len() < 6 {
        return Err("UID de badge invalide.".into());
    }
    let mut store = read_profiles(&app);
    let active_id = store.active_id.clone();
    // Un même badge ne peut pas ouvrir deux profils : sinon le déverrouillage
    // deviendrait ambigu et dépendrait de l'ordre du fichier.
    if store.profiles.iter().any(|p| {
        p.id != active_id
            && !p.rfid_hash.is_empty()
            && hash_password(&p.rfid_salt, &uid) == p.rfid_hash
    }) {
        return Err("Ce badge est déjà associé à un autre profil.".into());
    }
    // Un badge = un usage. Celui-ci déclenche déjà une action (modèle, mode,
    // voix) : en faire aussi une clé de session rendrait les deux ambigus.
    if crate::rfid_store::uid_has_binding(&app, &uid) {
        return Err(
            "Ce badge déclenche déjà une action. Retirez son association avant \
             d'en faire un badge d'ouverture de session."
                .into(),
        );
    }
    let profile = store
        .profiles
        .iter_mut()
        .find(|p| p.id == active_id)
        .ok_or_else(|| "Profil introuvable.".to_string())?;
    require_current_password(profile, current_password)?;
    profile.rfid_salt = random_salt();
    profile.rfid_hash = hash_password(&profile.rfid_salt, &uid);
    write_profiles(&app, &store)
}

/// Retire le badge du profil actif.
#[tauri::command]
pub fn session_clear_rfid(
    app: tauri::AppHandle,
    current_password: Option<String>,
) -> Result<(), String> {
    let mut store = read_profiles(&app);
    let active_id = store.active_id.clone();
    let profile = store
        .profiles
        .iter_mut()
        .find(|p| p.id == active_id)
        .ok_or_else(|| "Profil introuvable.".to_string())?;
    require_current_password(profile, current_password)?;
    profile.rfid_salt.clear();
    profile.rfid_hash.clear();
    write_profiles(&app, &store)
}

/// Déverrouille la session avec un badge RFID, en cherchant le profil qui lui
/// correspond : passer son badge sélectionne ET ouvre le bon profil.
///
/// Ne déverrouille JAMAIS un profil sans badge explicitement associé — un
/// profil sans mot de passe reste ouvert par le chemin normal, pas par ici.
/// La limitation de tentatives est la même que pour le mot de passe, sans quoi
/// le badge serait un contournement du blocage après cinq échecs.
#[tauri::command]
pub fn session_unlock_rfid(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionState>,
    uid: String,
) -> bool {
    let uid = normalize_uid(&uid);
    if uid.len() < 6 {
        return false;
    }
    {
        let Ok(r) = state.runtime.lock() else {
            return false;
        };
        if r.blocked_until.map(|t| Instant::now() < t).unwrap_or(false) {
            return false;
        }
    }
    let store = read_profiles(&app);
    let matched = store
        .profiles
        .iter()
        .find(|p| !p.rfid_hash.is_empty() && hash_password(&p.rfid_salt, &uid) == p.rfid_hash)
        .cloned();

    let Some(profile) = matched else {
        let Ok(mut r) = state.runtime.lock() else {
            return false;
        };
        r.failed_attempts = r.failed_attempts.saturating_add(1);
        if r.failed_attempts >= 5 {
            r.blocked_until = Some(Instant::now() + Duration::from_secs(30));
        }
        return false;
    };

    if store.active_id != profile.id {
        let mut store = store;
        store.active_id = profile.id.clone();
        if write_profiles(&app, &store).is_err() {
            return false;
        }
    }
    let Ok(mut r) = state.runtime.lock() else {
        return false;
    };
    r.unlocked = true;
    r.failed_attempts = 0;
    r.blocked_until = None;
    true
}

/// Vérifie le mot de passe. `true` si la session peut s'ouvrir (également le
/// cas si le verrouillage est désactivé ou sans mot de passe défini).
///
/// La bascule de profil est TRANSACTIONNELLE : le profil actif (et donc le
/// workspace/sandboxes servi par le backend) ne change qu'après vérification
/// réussie du mot de passe du profil visé. Un essai raté laisse le profil
/// actif inchangé.
#[tauri::command]
pub fn session_unlock(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionState>,
    profile_id: Option<String>,
    password: String,
) -> bool {
    let store = read_profiles(&app);
    let target_id = profile_id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| store.active_id.clone());
    let Some(p) = store.profiles.iter().find(|p| p.id == target_id).cloned() else {
        return false;
    };
    {
        let Ok(r) = state.runtime.lock() else {
            return false;
        };
        if r.blocked_until.map(|t| Instant::now() < t).unwrap_or(false) {
            return false;
        }
    }
    let ok = verify_profile_password(&p, &password);
    crate::devices::log("unlock-local", &p.id, None, "", ok, if ok { "" } else { "mot de passe refusé" });
    if ok {
        if store.active_id != p.id {
            let mut store = store;
            store.active_id = p.id.clone();
            if write_profiles(&app, &store).is_err() {
                return false;
            }
        }
        let Ok(mut r) = state.runtime.lock() else {
            return false;
        };
        r.unlocked = true;
        r.failed_attempts = 0;
        r.blocked_until = None;
        drop(r);
        // Les vues ouvertes pendant le verrou (mode application) se rechargent.
        let _ = app.emit("lumen-session-unlocked", ());
        true
    } else {
        let Ok(mut r) = state.runtime.lock() else {
            return false;
        };
        r.unlocked = false;
        r.failed_attempts = r.failed_attempts.saturating_add(1);
        if r.failed_attempts >= 5 {
            r.blocked_until = Some(Instant::now() + Duration::from_secs(30));
        }
        false
    }
}

/// Déverrouillage depuis un appareil appairé (compagnon, app iOS, Lumen XR),
/// après vérification du code TOTP du profil par l'appelant. Même garde que
/// le mot de passe : 5 échecs → 30 s de blocage, et seul le profil ouvert sur
/// l'ordinateur peut être déverrouillé (pas de changement de profil à distance).
pub fn remote_unlock(app: &tauri::AppHandle, profile_id: &str, code_ok: bool) -> Result<(), String> {
    let state = app.state::<SessionState>();
    let Ok(mut r) = state.runtime.lock() else {
        return Err("Session indisponible.".into());
    };
    if r.blocked_until.map(|t| Instant::now() < t).unwrap_or(false) {
        return Err("Trop d'essais : patiente 30 secondes.".into());
    }
    if active_profile_id(app) != profile_id {
        return Err("Un autre profil est ouvert sur l'ordinateur.".into());
    }
    if !code_ok {
        r.failed_attempts = r.failed_attempts.saturating_add(1);
        if r.failed_attempts >= 5 {
            r.blocked_until = Some(Instant::now() + Duration::from_secs(30));
        }
        return Err("Code incorrect.".into());
    }
    r.unlocked = true;
    r.failed_attempts = 0;
    r.blocked_until = None;
    drop(r);
    let _ = app.emit("lumen-session-unlocked", ());
    Ok(())
}

/// Reverrouille la session (fermeture du workspace, « Quitter »). Le prochain
/// accès repasse par l'écran de connexion.
#[tauri::command]
pub fn session_lock(state: tauri::State<'_, SessionState>) {
    if let Ok(mut r) = state.runtime.lock() {
        r.unlocked = false;
        r.config_grant_until = None;
        r.failed_attempts = 0;
        r.blocked_until = None;
    }
}

#[cfg(test)]
mod tests {
    use super::fold;

    /// Le nom du profil sert d'identifiant d'appairage sur le téléphone. Il doit
    /// donc se retrouver sans effort : personne ne tape ses accents ni ne
    /// respecte la casse dans un champ de connexion sur un mobile.
    #[test]
    fn le_nom_se_retrouve_sans_accents_ni_casse() {
        assert_eq!(fold("André"), "andre");
        assert_eq!(fold("  CAMILLE  "), "camille");
        assert_eq!(fold("Noël-Éloïse"), "noel-eloise");
        assert_eq!(fold("François"), "francois");
        // Deux écritures du même nom se rejoignent ; deux noms distincts non.
        assert_eq!(fold("andre"), fold("André"));
        assert_ne!(fold("Camille"), fold("Camillo"));
    }
}
