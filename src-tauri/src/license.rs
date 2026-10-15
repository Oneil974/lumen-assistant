//! Licence **Lumen Server** — activation par clé, vérifiée **hors ligne**.
//!
//! Les applications (Relia, Réunion, DB Studio, Reporting…) ne demandent plus
//! de licence : elles sont ouvertes à tous. La clé ne déverrouille plus que
//! l'usage d'un Lumen Server (publication et exécution d'agents sur le
//! serveur, cf. agents.rs). Le format historique `LUMEN-PRO.…` est conservé
//! pour que les clés déjà émises restent valides.
//!
//! Pourquoi une signature plutôt qu'un simple mot de passe : une chaîne
//! comparée en dur se lit dans le binaire en trente secondes (`strings`). Ici la
//! clé porte sa propre preuve — un message signé Ed25519 par une clé privée qui
//! ne quitte jamais le poste d'émission. Le binaire ne connaît que la clé
//! PUBLIQUE : même désassemblé entièrement, il ne permet pas d'en forger une.
//!
//! Ce n'est pas (et ne peut pas être) une protection contre quelqu'un qui
//! recompile le logiciel : le code source est là. C'est une barrière honnête,
//! qui tient hors ligne et sans jamais téléphoner à un serveur.
//!
//! Format de la clé, en une ligne : `LUMEN-PRO.<payload>.<signature>`
//!   - `payload`   : JSON en base64url **non paddé** — cf. [`Claims`] ;
//!   - `signature` : les 64 octets Ed25519 du payload **tel qu'encodé**, en
//!     base64url non paddé. On signe la forme encodée, pas le JSON reconstruit :
//!     deux sérialisations JSON du même objet peuvent différer d'un espace, et
//!     la signature ne pardonne pas un octet.
//!
//! Émission des clés : `node scripts/license-keygen.mjs` (une fois) puis
//! `node scripts/license-issue.mjs "Nom du client"`.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use tauri::Manager;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;

/// Clé **publique** d'émission des licences, en base64url non paddé (32 octets).
///
/// Remplacée à la main par la sortie de `scripts/license-keygen.mjs`. Tant
/// qu'elle vaut la valeur de démonstration ci-dessous, aucune clé ne peut être
/// validée : c'est volontaire — un dépôt public ne doit pas embarquer une paire
/// dont la moitié privée traîne dans l'historique.
//const ISSUER_PUBLIC_KEY: &str = "REPLACE_WITH_LICENSE_PUBLIC_KEY";
const ISSUER_PUBLIC_KEY: &str = "tGVEpStmBLTU26K-vbQIEd0C6XxNJGY1V6sLt4J4nJY";

/// Préfixe humain de la clé. Sert à ce qu'un utilisateur reconnaisse ce qu'il
/// colle, et à rejeter tôt un collage manifestement étranger.
const PREFIX: &str = "LUMEN-PRO";

/// Ce que l'émetteur signe. Volontairement minimal : tout champ ajouté ici
/// invalide les clés déjà émises, puisqu'il change les octets signés.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// Identifiant unique de la licence — sert au support, pas à la validation.
    pub id: String,
    /// Nom du détenteur, affiché dans les Paramètres.
    pub holder: String,
    /// Formule. Seul `"pro"` déverrouille aujourd'hui les applications Pro.
    pub plan: String,
    /// Émission, en secondes Unix.
    pub iat: i64,
    /// Expiration, en secondes Unix. `None` = licence perpétuelle.
    #[serde(default)]
    pub exp: Option<i64>,
}

/// État de la licence tel que l'interface le présente.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    /// Vrai si une licence valide et non expirée est installée.
    pub active: bool,
    pub plan: String,
    pub holder: String,
    /// Expiration en secondes Unix, `null` si perpétuelle.
    pub expires: Option<i64>,
    /// Raison lisible quand `active` est faux et qu'une clé est pourtant posée.
    pub error: Option<String>,
}

/// Cache mémoire : la vérification est bon marché, mais `pro_enabled` est appelé
/// à chaque ouverture de fenêtre et à chaque peinture du menu démarrer.
static CACHE: RwLock<Option<LicenseStatus>> = RwLock::new(None);

fn b64url_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    URL_SAFE_NO_PAD
        .decode(s.trim())
        .map_err(|_| "clé illisible (encodage)".to_string())
}

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn issuer_key() -> Result<VerifyingKey, String> {
    if ISSUER_PUBLIC_KEY == "REPLACE_WITH_LICENSE_PUBLIC_KEY" {
        return Err("ce build n'embarque pas de clé publique d'émission".into());
    }
    let raw = b64url_decode(ISSUER_PUBLIC_KEY)?;
    let bytes: [u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| "clé publique d'émission invalide".to_string())?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| "clé publique d'émission invalide".to_string())
}

/// Vérifie une clé **sans** l'installer. Rend les claims si la signature tient
/// et que la licence n'est pas expirée.
pub fn verify(key: &str) -> Result<Claims, String> {
    verify_with(&issuer_key()?, key)
}

/// Cœur de la vérification, avec la clé publique passée en paramètre.
///
/// Séparé de [`verify`] pour une seule raison : la clé du binaire est une
/// constante de compilation. Sans ce point d'entrée, éprouver le format des
/// clés demanderait de recompiler avec une vraie clé d'émission — donc, en
/// pratique, de ne jamais l'éprouver. Le test ci-dessous s'en sert pour vérifier
/// qu'une clé produite par `scripts/license-issue.mjs` est bien acceptée ici.
fn verify_with(issuer: &VerifyingKey, key: &str) -> Result<Claims, String> {
    let key = key.trim();
    let mut parts = key.split('.');
    let prefix = parts.next().unwrap_or("");
    if prefix != PREFIX {
        return Err("ce n'est pas une clé Lumen Pro".into());
    }
    let payload = parts.next().ok_or("clé incomplète")?;
    let sig_b64 = parts.next().ok_or("clé incomplète")?;
    if parts.next().is_some() {
        return Err("clé mal formée".into());
    }

    let sig_bytes: [u8; 64] = b64url_decode(sig_b64)?
        .as_slice()
        .try_into()
        .map_err(|_| "signature de taille invalide".to_string())?;
    issuer
        .verify(payload.as_bytes(), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| "signature invalide — cette clé n'a pas été émise par Lumen".to_string())?;

    let claims: Claims = serde_json::from_slice(&b64url_decode(payload)?)
        .map_err(|_| "contenu de la clé illisible".to_string())?;
    if let Some(exp) = claims.exp {
        if now_secs() > exp {
            return Err("licence expirée".into());
        }
    }
    Ok(claims)
}

fn license_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_config_dir(app.path())
        .map_err(|e| format!("dossier de configuration introuvable : {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("license.key"))
}

fn read_key(app: &tauri::AppHandle) -> Option<String> {
    let path = license_path(app).ok()?;
    std::fs::read_to_string(path).ok().filter(|s| !s.trim().is_empty())
}

fn compute(app: &tauri::AppHandle) -> LicenseStatus {
    let Some(key) = read_key(app) else {
        return LicenseStatus::default();
    };
    match verify(&key) {
        Ok(c) => LicenseStatus {
            active: c.plan == "pro",
            plan: c.plan,
            holder: c.holder,
            expires: c.exp,
            error: None,
        },
        Err(e) => LicenseStatus { error: Some(e), ..Default::default() },
    }
}

/// État courant, mis en cache. Le cache n'est vidé que par une activation ou une
/// suppression : une licence à durée limitée expire donc au redémarrage suivant,
/// pas au milieu d'une session — c'est délibéré, on ne coupe pas le travail en
/// cours sous les doigts de quelqu'un.
pub fn status(app: &tauri::AppHandle) -> LicenseStatus {
    if let Ok(guard) = CACHE.read() {
        if let Some(s) = guard.as_ref() {
            return s.clone();
        }
    }
    let fresh = compute(app);
    if let Ok(mut guard) = CACHE.write() {
        *guard = Some(fresh.clone());
    }
    fresh
}

/// Vrai si l'usage de Lumen Server est déverrouillé sur ce poste.
pub fn is_pro(app: &tauri::AppHandle) -> bool {
    status(app).active
}

fn invalidate() {
    if let Ok(mut guard) = CACHE.write() {
        *guard = None;
    }
}

#[tauri::command]
pub fn license_status(app: tauri::AppHandle) -> LicenseStatus {
    status(&app)
}

/// Installe une clé. Refuse d'écrire quoi que ce soit si elle ne vérifie pas :
/// une clé invalide posée sur le disque ferait croire, au redémarrage suivant,
/// à une licence cassée plutôt qu'à une faute de frappe.
#[tauri::command]
pub fn license_activate(app: tauri::AppHandle, key: String) -> Result<LicenseStatus, String> {
    let claims = verify(&key)?;
    if claims.plan != "pro" {
        return Err(format!("formule « {} » non reconnue", claims.plan));
    }
    std::fs::write(license_path(&app)?, key.trim())
        .map_err(|e| format!("écriture de la licence impossible : {e}"))?;
    invalidate();
    let st = status(&app);
    let _ = tauri::Emitter::emit(&app, "lumen-license", &st);
    Ok(st)
}

/// Retire la licence de ce poste. Ne détruit aucune donnée : seule la liaison
/// avec Lumen Server cesse de servir.
#[tauri::command]
pub fn license_clear(app: tauri::AppHandle) -> Result<LicenseStatus, String> {
    if let Ok(path) = license_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    invalidate();
    let st = status(&app);
    let _ = tauri::Emitter::emit(&app, "lumen-license", &st);
    Ok(st)
}


#[cfg(test)]
mod tests {
    use super::{verify_with, VerifyingKey};

    /// Paire d'essai produite par `scripts/license-keygen.mjs`, sans aucun
    /// rapport avec la clé d'émission réelle — celle-ci ne doit jamais entrer
    /// dans le dépôt. Elle sert uniquement à figer le FORMAT.
    const TEST_PUB: &str = "DXnEmTvvfN2KSVSzLanMpkceyVrxO74EI2OIDzwb9hY";
    const TEST_LICENSE: &str = "LUMEN-PRO.eyJpZCI6ImZmMDY5MDc4LThhODctNGEzNC04YTc0LTdkNjlhNDVmYzQ5ZSIsImhvbGRlciI6IlRlc3QgTHVtZW4iLCJwbGFuIjoicHJvIiwiaWF0IjoxNzg4OTQ3NTg1LCJleHAiOm51bGx9.tjzOqcoC0w6vYMpFdfh--e7bDZE6mQLDIJztMtRTogYvJzuQfCnuGxthU1aXk1sNBftJEuI3UbSj68vQuZQRDA";

    fn key() -> VerifyingKey {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        let raw: [u8; 32] = URL_SAFE_NO_PAD.decode(TEST_PUB).unwrap().try_into().unwrap();
        VerifyingKey::from_bytes(&raw).unwrap()
    }

    #[test]
    fn accepte_une_cle_emise_par_le_script() {
        let claims = verify_with(&key(), TEST_LICENSE).expect("la clé d'essai doit vérifier");
        assert_eq!(claims.plan, "pro");
        assert_eq!(claims.holder, "Test Lumen");
        assert!(claims.exp.is_none(), "licence perpétuelle");
    }

    #[test]
    fn refuse_une_signature_falsifiee() {
        // On retouche UN caractère du payload : la signature ne couvre plus rien.
        let mut parts = TEST_LICENSE.split('.');
        let (prefix, payload, sig) = (
            parts.next().unwrap(),
            parts.next().unwrap(),
            parts.next().unwrap(),
        );
        let tampered = format!("{prefix}.{}A.{sig}", &payload[..payload.len() - 1]);
        assert!(verify_with(&key(), &tampered).is_err());
    }

    #[test]
    fn refuse_ce_qui_n_est_pas_une_cle_lumen() {
        assert!(verify_with(&key(), "bonjour").is_err());
        assert!(verify_with(&key(), "LUMEN-PRO.incomplet").is_err());
        assert!(verify_with(&key(), "AUTRE-CHOSE.a.b").is_err());
    }
}
