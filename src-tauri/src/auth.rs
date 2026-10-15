// ===== Authentification du compagnon (TOTP + jeton de session) =====
//
// Le serveur compagnon (mobile) écoute sur le LAN — et potentiellement via un
// VPN, donc hors réseau local. Il doit donc être protégé. Les raccourcis, eux,
// passent par la boucle locale `127.0.0.1` (jamais exposée) et n'ont PAS besoin
// de cette authentification.
//
// Modèle :
//   1. CHAQUE PROFIL utilisateur de Lumen OS a son propre secret TOTP, généré à
//      la demande et persisté. L'onglet « Compagnon » des Paramètres affiche,
//      pour le profil choisi, un code à 6 chiffres qui tourne toutes les 30 s
//      (RFC 6238, compatible avec une app d'authentification via l'URI
//      otpauth://, où le compte porte le nom du profil).
//   2. Appairage : le téléphone POSTe `{identifier, code}` sur `/auth/pair`.
//      L'IDENTIFIANT EST LE NOM DU PROFIL — celui de l'écran de connexion du
//      Mac, insensible à la casse et aux accents. Il n'y a donc rien de plus à
//      retenir, et rien à configurer. Si le code TOTP de ce profil est valide,
//      Lumen renvoie un JETON DE SESSION signé (HMAC-SHA256 avec le secret du
//      profil) et de longue durée, stocké côté téléphone — plus besoin de
//      retaper le code.
//   3. Le jeton PORTE l'identité : `"<profil>.<expiration>.<signature>"`. Chaque
//      requête protégée (WebSocket, images, capture, agents) le revalide et sait
//      donc QUI parle. Plusieurs personnes peuvent être appairées et connectées
//      en même temps ; chacune n'a que ses propres droits.
//   4. Régénérer le secret d'un profil invalide ses jetons à lui, et seulement
//      les siens.
//   5. Le code TOTP est visible dans les Réglages de Lumen : le connaître ne
//      prouve PAS qu'on a ouvert la session. Pour un profil protégé par mot de
//      passe, `/auth/pair` ne rend donc qu'un TICKET (5 min) et une clé P-256
//      éphémère ; `/auth/login` attend ensuite le mot de passe de session,
//      chiffré pour cette clé (ECDH + HKDF + AES-GCM) — ou en clair, mais
//      seulement sur l'écouteur HTTPS. L'empreinte du mot de passe entre dans
//      la signature des jetons : le changer déconnecte les téléphones.
//
// Ce que ce modèle ne fait PAS : il n'ouvre pas la session Lumen OS du profil.
// Le Mac n'a qu'un seul bureau actif à la fois ; le téléphone d'un profil qui
// n'est pas l'actif n'accède donc pas à la conversation en cours (cf.
// `companion.rs`), il garde ses fonctions propres (capture, agents).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tokio::sync::Mutex;

type HmacSha256 = Hmac<Sha256>;

/// Durée de validité d'un jeton de session : 30 jours.
const TOKEN_TTL_SECS: u64 = 30 * 24 * 3600;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Secret d'appairage d'UN profil.
#[derive(Clone, Serialize, Deserialize)]
struct AuthUser {
    /// Identifiant du profil Lumen OS (`session_profiles.json`).
    profile_id: String,
    /// Secret TOTP, encodé en base64 pour la persistance.
    secret_b64: String,
    /// Ancien identifiant libre, conservé pour les installations qui en avaient
    /// un : il reste ACCEPTÉ à l'appairage, mais n'est plus ni affiché ni
    /// modifiable. Le nom du profil le remplace.
    #[serde(default)]
    identifier: String,
}

/// Contenu persistant. Les champs `secret_b64`/`identifier` de premier niveau
/// sont ceux de l'ancienne version mono-utilisateur : ils sont migrés vers le
/// profil actif au premier démarrage, puis laissés en place (un retour à une
/// version antérieure retrouve son secret).
#[derive(Clone, Default, Serialize, Deserialize)]
struct AuthInner {
    #[serde(default)]
    users: Vec<AuthUser>,
    #[serde(default)]
    secret_b64: String,
    #[serde(default)]
    identifier: String,
}

/// Infos publiques renvoyées à l'UI pour l'onglet Compagnon.
#[derive(Clone, Serialize)]
pub struct AuthInfo {
    /// Profil auquel se rapportent ce code.
    pub profile_id: String,
    /// Nom du profil : c'est LUI que l'on saisit sur le téléphone.
    pub profile_name: String,
    /// Code TOTP courant (6 chiffres) — affiché pour l'appairage manuel.
    pub current_code: String,
    /// Secondes restantes avant rotation du code.
    pub seconds_remaining: u64,
    /// URI otpauth:// (pour une app d'authentification, si l'utilisateur préfère).
    pub otpauth_uri: String,
    /// Clé d'association en base32 (RFC 4648, sans padding) — à coller dans
    /// l'app « Mots de passe » de macOS ou un authenticator pour la saisie manuelle.
    pub secret_base32: String,
    /// Code QR de l'URI otpauth, prêt à afficher (image SVG inline).
    pub qr_svg: String,
}

#[derive(Clone, Default)]
pub struct AuthState {
    inner: Arc<Mutex<Option<AuthInner>>>,
    path: Arc<Mutex<Option<PathBuf>>>,
    /// Poignée de l'app, posée par `init` : la signature des jetons dépend du
    /// mot de passe de session, lu dans les profils.
    app: Arc<std::sync::OnceLock<tauri::AppHandle>>,
    /// Connexions en cours : TOTP validé, mot de passe attendu.
    tickets: Arc<Mutex<HashMap<String, LoginTicket>>>,
    /// Échecs récents par clé (profil ou identifiant) : freine la force brute.
    failures: Arc<Mutex<HashMap<String, Failures>>>,
}

/// Durée de vie d'un ticket de connexion (entre le TOTP et le mot de passe).
const TICKET_TTL: Duration = Duration::from_secs(300);
/// Essais de mot de passe autorisés par ticket.
const TICKET_ATTEMPTS: u32 = 5;
/// Échecs tolérés avant temporisation, par profil / identifiant.
const FREE_FAILURES: u32 = 5;

/// Étape intermédiaire de la connexion d'un compagnon : le code TOTP a prouvé
/// que la personne a accès aux Réglages (ou à l'application d'authentification),
/// mais cela ne vaut PAS session ouverte : il faut encore le mot de passe.
struct LoginTicket {
    profile_id: String,
    device_name: String,
    device_kind: String,
    expires: Instant,
    attempts: u32,
    /// Clé P-256 éphémère du serveur : le téléphone chiffre le mot de passe
    /// pour elle (ECDH + HKDF-SHA256 + AES-256-GCM), si bien qu'il ne circule
    /// jamais en clair, même sur l'écouteur HTTP du réseau local.
    key: p256::SecretKey,
}

#[derive(Default, Clone, Copy)]
struct Failures {
    count: u32,
    blocked_until: Option<Instant>,
}

/// Résultat de la première étape de connexion (`/auth/pair`).
pub enum PairOutcome {
    /// Profil sans mot de passe de session : l'appelant émet le jeton tout de suite.
    Direct { profile_id: String },
    /// Mot de passe requis : ticket + clé publique du serveur (SEC1, base64).
    NeedPassword { profile_id: String, ticket: String, server_key: String },
    Refused,
    /// Trop d'échecs : réessayer dans N secondes.
    Throttled(u64),
}

/// Mot de passe transmis par le compagnon.
pub enum PasswordProof {
    /// Chiffré pour la clé du ticket (tout transport).
    Envelope { client_key: String, iv: String, ciphertext: String },
    /// En clair : accepté UNIQUEMENT sur l'écouteur HTTPS.
    Plain(String),
}

pub enum LoginOutcome {
    /// Mot de passe correct : l'appelant inscrit l'appareil et émet le jeton.
    Ok { profile_id: String },
    WrongPassword { remaining: u32 },
    /// Ticket inconnu, expiré ou épuisé : recommencer au code TOTP.
    Expired,
    Throttled(u64),
    BadRequest(&'static str),
}

fn random_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).expect("source d'entropie indisponible");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_p256() -> p256::SecretKey {
    loop {
        let mut buf = [0u8; 32];
        getrandom::getrandom(&mut buf).expect("source d'entropie indisponible");
        if let Ok(k) = p256::SecretKey::from_slice(&buf) {
            return k;
        }
    }
}

/// Déchiffre l'enveloppe du mot de passe. Le ticket sert de sel HKDF ET de
/// données associées : une enveloppe ne se rejoue pas sur un autre ticket.
pub(crate) fn open_envelope(
    key: &p256::SecretKey,
    ticket: &str,
    client_key_b64: &str,
    iv_b64: &str,
    ct_b64: &str,
) -> Option<String> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let client = p256::PublicKey::from_sec1_bytes(&b64.decode(client_key_b64.trim()).ok()?).ok()?;
    let iv = b64.decode(iv_b64.trim()).ok()?;
    let ct = b64.decode(ct_b64.trim()).ok()?;
    if iv.len() != 12 || ct.len() < 16 || ct.len() > 4096 {
        return None;
    }
    let shared = p256::ecdh::diffie_hellman(key.to_nonzero_scalar(), client.as_affine());
    let hk = hkdf::Hkdf::<Sha256>::new(Some(ticket.as_bytes()), shared.raw_secret_bytes());
    let mut aes_key = [0u8; 32];
    hk.expand(b"lumen-companion-login-v1", &mut aes_key).ok()?;
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&aes_key).ok()?;
    let plain = cipher
        .decrypt(
            aes_gcm::Nonce::from_slice(&iv),
            Payload { msg: &ct, aad: ticket.as_bytes() },
        )
        .ok()?;
    String::from_utf8(plain).ok()
}

/// Rend l'URI otpauth en QR code SVG (sans dépendance image). Renvoie une chaîne
/// vide en cas d'échec — l'UI retombe alors sur la clé/le code manuels.
pub(crate) fn qr_svg(uri: &str) -> String {
    use qrcode::render::svg;
    match qrcode::QrCode::new(uri.as_bytes()) {
        Ok(code) => code
            .render::<svg::Color>()
            .min_dimensions(180, 180)
            .quiet_zone(true)
            .dark_color(svg::Color("#101014"))
            .light_color(svg::Color("#ffffff"))
            .build(),
        Err(_) => String::new(),
    }
}

fn random_secret() -> Vec<u8> {
    // 20 octets aléatoires (160 bits) — taille recommandée pour TOTP-SHA1.
    let mut buf = [0u8; 20];
    getrandom::getrandom(&mut buf).expect("source d'entropie indisponible");
    buf.to_vec()
}

impl AuthState {
    /// Le compte affiché dans l'app d'authentification porte le nom du profil :
    /// avec plusieurs personnes appairées, « Lumen (Camille) » et
    /// « Lumen (Mickaël) » restent distinguables dans la liste des codes.
    fn build_totp(secret: &[u8], account: &str) -> totp_rs::TOTP {
        totp_rs::TOTP::new(
            totp_rs::Algorithm::SHA1,
            6,
            1,
            30,
            secret.to_vec(),
            Some("Lumen".to_string()),
            account.to_string(),
        )
        .expect("paramètres TOTP valides")
    }

    fn secret_bytes(user: &AuthUser) -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(user.secret_b64.as_bytes())
            .unwrap_or_default()
    }

    /// Charge la config d'auth. Tolérant aux pannes.
    pub async fn init(&self, app: &tauri::AppHandle) {
        use tauri::Manager;

        let _ = self.app.set(app.clone());
        let path = crate::paths::shared_data_dir(app.path())
            .ok()
            .map(|d| d.join("companion_auth.json"));

        if let Some(ref p) = path {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(txt) = std::fs::read_to_string(p) {
                if let Ok(cfg) = serde_json::from_str::<AuthInner>(&txt) {
                    *self.inner.lock().await = Some(cfg);
                }
            }
        }
        *self.path.lock().await = path;
        if self.inner.lock().await.is_none() {
            *self.inner.lock().await = Some(AuthInner::default());
        }

        // Migration depuis la version mono-utilisateur : le secret existant
        // devient celui du profil actif, avec son identifiant. Sans cela, un
        // téléphone déjà appairé serait déconnecté par la mise à jour.
        let active = crate::session::active_profile_id(app);
        let legacy = {
            let guard = self.inner.lock().await;
            guard
                .as_ref()
                .filter(|c| c.users.is_empty() && !c.secret_b64.is_empty())
                .map(|c| (c.secret_b64.clone(), c.identifier.clone()))
        };
        if let Some((secret_b64, identifier)) = legacy {
            if let Some(cfg) = self.inner.lock().await.as_mut() {
                cfg.users.push(AuthUser {
                    profile_id: active.clone(),
                    secret_b64,
                    identifier: if identifier.trim().is_empty() {
                        active.clone()
                    } else {
                        identifier
                    },
                });
            }
            self.persist().await;
        }
        self.ensure_user(&active).await;
    }

    async fn persist(&self) {
        let path = { self.path.lock().await.clone() };
        let (Some(path), Some(cfg)) = (path, self.inner.lock().await.clone()) else {
            return;
        };
        if let Ok(txt) = serde_json::to_string_pretty(&cfg) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, txt.as_bytes()).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    /// Crée le secret d'un profil s'il n'en a pas encore. Idempotent.
    pub async fn ensure_user(&self, profile_id: &str) {
        use base64::Engine;
        if profile_id.is_empty() {
            return;
        }
        let missing = {
            let guard = self.inner.lock().await;
            guard
                .as_ref()
                .map(|c| !c.users.iter().any(|u| u.profile_id == profile_id))
                .unwrap_or(false)
        };
        if !missing {
            return;
        }
        if let Some(cfg) = self.inner.lock().await.as_mut() {
            cfg.users.push(AuthUser {
                profile_id: profile_id.to_string(),
                secret_b64: base64::engine::general_purpose::STANDARD.encode(random_secret()),
                identifier: String::new(),
            });
        }
        self.persist().await;
    }

    async fn user(&self, profile_id: &str) -> Option<AuthUser> {
        let guard = self.inner.lock().await;
        guard
            .as_ref()?
            .users
            .iter()
            .find(|u| u.profile_id == profile_id)
            .cloned()
    }

    /// Infos publiques d'un profil (identifiant + code courant + URI + QR + clé).
    pub async fn info(&self, app: &tauri::AppHandle, profile_id: &str) -> Option<AuthInfo> {
        let profile_id = if profile_id.is_empty() {
            crate::session::active_profile_id(app)
        } else {
            profile_id.to_string()
        };
        self.ensure_user(&profile_id).await;
        let user = self.user(&profile_id).await?;
        let name = crate::session::find_profile_identity(app, &profile_id)
            .map(|p| p.name)
            .unwrap_or_else(|| profile_id.clone());
        let secret = Self::secret_bytes(&user);
        let totp = Self::build_totp(&secret, &name);
        let uri = totp.get_url();
        Some(AuthInfo {
            profile_id: user.profile_id.clone(),
            profile_name: name,
            current_code: totp.generate_current().unwrap_or_default(),
            seconds_remaining: 30 - (now_secs() % 30),
            secret_base32: base32::encode(base32::Alphabet::Rfc4648 { padding: false }, &secret),
            qr_svg: qr_svg(&uri),
            otpauth_uri: uri,
        })
    }

    /// Régénère le secret d'un profil : invalide SES jetons, pas ceux des autres.
    pub async fn regenerate(&self, profile_id: &str) {
        use base64::Engine;
        self.ensure_user(profile_id).await;
        if let Some(cfg) = self.inner.lock().await.as_mut() {
            if let Some(user) = cfg.users.iter_mut().find(|u| u.profile_id == profile_id) {
                user.secret_b64 =
                    base64::engine::general_purpose::STANDARD.encode(random_secret());
            }
        }
        self.persist().await;
    }

    /// Vérifie un couple identifiant + code TOTP contre TOUS les profils.
    /// Renvoie l'id du profil reconnu. Tolère ±1 fenêtre (30 s) pour l'horloge.
    pub async fn verify_pairing(
        &self,
        app: &tauri::AppHandle,
        identifier: &str,
        code: &str,
    ) -> Option<String> {
        let needle = crate::session::fold(identifier);
        if needle.is_empty() {
            return None;
        }
        let users = {
            let guard = self.inner.lock().await;
            guard.as_ref().map(|c| c.users.clone()).unwrap_or_default()
        };
        for user in users {
            // On saisit son NOM, celui de l'écran de connexion du Mac. L'id
            // technique du profil et l'ancien identifiant libre restent acceptés
            // pour ne pas couper les téléphones appairés avant ce changement.
            let identity = crate::session::find_profile_identity(app, &user.profile_id);
            let name_matches = identity
                .as_ref()
                .map(|p| crate::session::fold(&p.name) == needle)
                .unwrap_or(false);
            let legacy_matches =
                !user.identifier.is_empty() && crate::session::fold(&user.identifier) == needle;
            if !name_matches && !legacy_matches && crate::session::fold(&user.profile_id) != needle {
                continue;
            }
            let secret = Self::secret_bytes(&user);
            let name = identity
                .map(|p| p.name)
                .unwrap_or_else(|| user.profile_id.clone());
            if Self::build_totp(&secret, &name)
                .check_current(code)
                .unwrap_or(false)
            {
                return Some(user.profile_id);
            }
        }
        None
    }

    /// Vérifie le code TOTP courant d'UN profil (déverrouillage à distance :
    /// le téléphone est déjà appairé, le code prouve que son porteur a aussi
    /// l'application d'authentification en main).
    pub async fn verify_profile_code(&self, app: &tauri::AppHandle, profile_id: &str, code: &str) -> bool {
        let Some(user) = self.user(profile_id).await else { return false };
        let name = crate::session::find_profile_identity(app, profile_id)
            .map(|p| p.name)
            .unwrap_or_else(|| profile_id.to_string());
        Self::build_totp(&Self::secret_bytes(&user), &name)
            .check_current(code.trim())
            .unwrap_or(false)
    }

    // ----- Temporisation des échecs -----

    async fn throttled(&self, key: &str) -> Option<u64> {
        let now = Instant::now();
        let guard = self.failures.lock().await;
        let until = guard.get(key)?.blocked_until?;
        (until > now).then(|| (until - now).as_secs().max(1))
    }

    async fn fail(&self, key: &str) {
        let mut guard = self.failures.lock().await;
        let f = guard.entry(key.to_string()).or_default();
        f.count += 1;
        if f.count >= FREE_FAILURES {
            // 30 s, 1 min, 2 min… plafonné à 15 min.
            let exp = (f.count - FREE_FAILURES).min(5);
            let secs = (30u64 << exp).min(900);
            f.blocked_until = Some(Instant::now() + Duration::from_secs(secs));
        }
    }

    async fn succeed(&self, key: &str) {
        self.failures.lock().await.remove(key);
    }

    /// Étape 1 : identifiant + code TOTP. Si le profil a un mot de passe de
    /// session, AUCUN jeton n'est émis : on rend un ticket de 5 minutes.
    pub async fn begin_login(
        &self,
        app: &tauri::AppHandle,
        identifier: &str,
        code: &str,
        device_name: &str,
        device_kind: &str,
    ) -> PairOutcome {
        let key = format!("pair:{}", crate::session::fold(identifier));
        if let Some(wait) = self.throttled(&key).await {
            return PairOutcome::Throttled(wait);
        }
        let Some(profile_id) = self.verify_pairing(app, identifier, code).await else {
            self.fail(&key).await;
            return PairOutcome::Refused;
        };
        self.succeed(&key).await;
        if crate::session::profile_password_binding(app, &profile_id).is_none() {
            return PairOutcome::Direct { profile_id };
        }
        let ticket = random_hex(24);
        let secret = random_p256();
        let server_key = {
            use base64::Engine;
            use p256::elliptic_curve::sec1::ToEncodedPoint;
            base64::engine::general_purpose::STANDARD
                .encode(secret.public_key().to_encoded_point(false).as_bytes())
        };
        let mut tickets = self.tickets.lock().await;
        let now = Instant::now();
        tickets.retain(|_, t| t.expires > now);
        if tickets.len() >= 64 {
            // Personne n'ouvre 64 connexions à la fois : on jette la plus ancienne.
            if let Some(oldest) = tickets.iter().min_by_key(|(_, t)| t.expires).map(|(k, _)| k.clone()) {
                tickets.remove(&oldest);
            }
        }
        tickets.insert(
            ticket.clone(),
            LoginTicket {
                profile_id: profile_id.clone(),
                device_name: device_name.to_string(),
                device_kind: device_kind.to_string(),
                expires: now + TICKET_TTL,
                attempts: 0,
                key: secret,
            },
        );
        PairOutcome::NeedPassword { profile_id, ticket, server_key }
    }

    /// Étape 2 : mot de passe de session. `secure_transport` = requête reçue
    /// sur l'écouteur HTTPS (seul cas où le mot de passe en clair est admis).
    /// Renvoie aussi le nom/type d'appareil mémorisés à l'étape 1.
    pub async fn finish_login(
        &self,
        app: &tauri::AppHandle,
        ticket: &str,
        proof: PasswordProof,
        secure_transport: bool,
    ) -> (LoginOutcome, String, String) {
        let mut tickets = self.tickets.lock().await;
        let now = Instant::now();
        tickets.retain(|_, t| t.expires > now);
        let Some(t) = tickets.get_mut(ticket) else {
            return (LoginOutcome::Expired, String::new(), String::new());
        };
        let profile_id = t.profile_id.clone();
        let device = (t.device_name.clone(), t.device_kind.clone());
        let limiter = format!("login:{profile_id}");
        drop(tickets);
        if let Some(wait) = self.throttled(&limiter).await {
            return (LoginOutcome::Throttled(wait), device.0, device.1);
        }
        let mut tickets = self.tickets.lock().await;
        let Some(t) = tickets.get_mut(ticket) else {
            return (LoginOutcome::Expired, device.0, device.1);
        };
        let password = match proof {
            PasswordProof::Envelope { client_key, iv, ciphertext } => {
                match open_envelope(&t.key, ticket, &client_key, &iv, &ciphertext) {
                    Some(p) => p,
                    None => return (LoginOutcome::BadRequest("enveloppe illisible"), device.0, device.1),
                }
            }
            PasswordProof::Plain(p) if secure_transport => p,
            PasswordProof::Plain(_) => {
                return (
                    LoginOutcome::BadRequest("mot de passe en clair refusé hors HTTPS"),
                    device.0,
                    device.1,
                )
            }
        };
        if !crate::session::check_profile_password(app, &profile_id, &password) {
            t.attempts += 1;
            let remaining = TICKET_ATTEMPTS.saturating_sub(t.attempts);
            if remaining == 0 {
                tickets.remove(ticket);
            }
            drop(tickets);
            self.fail(&limiter).await;
            let outcome = if remaining == 0 {
                LoginOutcome::Expired
            } else {
                LoginOutcome::WrongPassword { remaining }
            };
            return (outcome, device.0, device.1);
        }
        // Un ticket ne sert qu'une fois.
        tickets.remove(ticket);
        drop(tickets);
        self.succeed(&limiter).await;
        (LoginOutcome::Ok { profile_id }, device.0, device.1)
    }

    /// Émet un jeton de session signé : `"<profil>~<appareil>.<exp>.<hmac_hex>"`
    /// (l'appareil, inscrit au registre de devices.rs, rend la révocation
    /// possible appareil par appareil).
    pub async fn issue_token(&self, profile_id: &str, device_id: Option<&str>) -> Option<String> {
        let user = self.user(profile_id).await?;
        let secret = Self::secret_bytes(&user);
        let exp = now_secs() + TOKEN_TTL_SECS;
        let subject = match device_id {
            Some(d) => format!("{profile_id}~{d}"),
            None => profile_id.to_string(),
        };
        let binding = self.password_binding(profile_id);
        let sig = Self::sign(&secret, &subject, exp, binding.as_deref());
        Some(format!("{subject}.{exp}.{sig}"))
    }

    /// Valide un jeton et renvoie le profil qu'il désigne.
    pub async fn verify_token(&self, token: &str) -> Option<String> {
        self.verify_token_device(token).await.map(|(p, _)| p)
    }

    /// Profil + appareil d'un jeton. Un jeton d'avant le registre (sans
    /// appareil) reste valide ; un appareil révoqué ne l'est plus.
    pub async fn verify_token_device(&self, token: &str) -> Option<(String, Option<String>)> {
        let mut parts = token.rsplitn(3, '.');
        let sig = parts.next()?;
        let exp_str = parts.next()?;
        let subject = parts.next()?;
        let exp = exp_str.parse::<u64>().ok()?;
        if exp < now_secs() {
            return None;
        }
        let (profile_id, device) = match subject.split_once('~') {
            Some((p, d)) => (p, Some(d.to_string())),
            None => (subject, None),
        };
        let user = self.user(profile_id).await?;
        let secret = Self::secret_bytes(&user);
        // Comparaison sur des hex dérivés du même secret : pas d'oracle de
        // temporisation exploitable en pratique ici.
        // Le mot de passe de session entre dans la signature : un jeton émis
        // avant qu'il soit posé (ou changé) ne vaut plus rien.
        let binding = self.password_binding(profile_id);
        if Self::sign(&secret, subject, exp, binding.as_deref()) != sig {
            return None;
        }
        if let Some(d) = &device {
            if !crate::devices::check(profile_id, d) {
                return None;
            }
        }
        Some((profile_id.to_string(), device))
    }

    fn password_binding(&self, profile_id: &str) -> Option<String> {
        self.app
            .get()
            .and_then(|app| crate::session::profile_password_binding(app, profile_id))
    }

    fn sign(secret: &[u8], profile_id: &str, exp: u64, binding: Option<&str>) -> String {
        let mut mac = HmacSha256::new_from_slice(secret).expect("clé HMAC valide");
        mac.update(profile_id.as_bytes());
        mac.update(b".");
        mac.update(exp.to_string().as_bytes());
        if let Some(b) = binding {
            mac.update(b"|pw|");
            mac.update(b.as_bytes());
        }
        let bytes = mac.finalize().into_bytes();
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

// ===== Commandes Tauri (onglet Compagnon) =====

#[tauri::command]
pub async fn companion_auth_info(
    app: tauri::AppHandle,
    auth: tauri::State<'_, AuthState>,
    profile_id: Option<String>,
) -> Result<Option<AuthInfo>, String> {
    Ok(auth.info(&app, &profile_id.unwrap_or_default()).await)
}

/// Liste des profils appairables, pour le sélecteur des Paramètres.
#[tauri::command]
pub fn companion_auth_profiles(app: tauri::AppHandle) -> Vec<crate::session::ProfileIdentity> {
    crate::session::profile_identities(&app)
}

#[tauri::command]
pub async fn companion_regenerate_secret(
    app: tauri::AppHandle,
    auth: tauri::State<'_, AuthState>,
    profile_id: Option<String>,
) -> Result<(), String> {
    let profile = profile_id
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| crate::session::active_profile_id(&app));
    auth.regenerate(&profile).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use base64::Engine;
    use p256::elliptic_curve::sec1::ToEncodedPoint;

    /// Chiffre comme le font l'app iOS (CryptoKit) et la PWA (WebCrypto).
    fn seal(server_pub: &p256::PublicKey, ticket: &str, password: &str) -> (String, String, String) {
        let b64 = base64::engine::general_purpose::STANDARD;
        let client = random_p256();
        let shared = p256::ecdh::diffie_hellman(client.to_nonzero_scalar(), server_pub.as_affine());
        let hk = hkdf::Hkdf::<Sha256>::new(Some(ticket.as_bytes()), shared.raw_secret_bytes());
        let mut key = [0u8; 32];
        hk.expand(b"lumen-companion-login-v1", &mut key).unwrap();
        let iv = [7u8; 12];
        let ct = aes_gcm::Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .encrypt(aes_gcm::Nonce::from_slice(&iv), Payload { msg: password.as_bytes(), aad: ticket.as_bytes() })
            .unwrap();
        (
            b64.encode(client.public_key().to_encoded_point(false).as_bytes()),
            b64.encode(iv),
            b64.encode(ct),
        )
    }

    #[test]
    fn enveloppe_du_mot_de_passe_aller_retour() {
        let server = random_p256();
        let (k, iv, ct) = seal(&server.public_key(), "ticket-a", "mot de passe é");
        assert_eq!(open_envelope(&server, "ticket-a", &k, &iv, &ct).as_deref(), Some("mot de passe é"));
        // Rejouée sur un autre ticket : refusée (sel HKDF + données associées).
        assert!(open_envelope(&server, "ticket-b", &k, &iv, &ct).is_none());
        // Autre clé serveur : illisible.
        assert!(open_envelope(&random_p256(), "ticket-a", &k, &iv, &ct).is_none());
    }

    #[test]
    fn signature_liee_au_mot_de_passe() {
        let secret = [1u8; 20];
        let libre = AuthState::sign(&secret, "p~d", 10, None);
        let lie = AuthState::sign(&secret, "p~d", 10, Some("sha256-iter-v1:abc"));
        let change = AuthState::sign(&secret, "p~d", 10, Some("sha256-iter-v1:abd"));
        assert_ne!(libre, lie);
        assert_ne!(lie, change);
    }
}
