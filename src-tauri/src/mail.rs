//! App Email : client IMAP (lecture) et SMTP (envoi), en pur rustls.
//!
//! Pourquoi un client IMAP écrit à la main plutôt que la crate `imap` ? Parce
//! que sa version stable impose `native-tls`, donc OpenSSL sous Windows et
//! Linux. Ce projet a déjà retiré une dépendance pour cette raison exacte
//! (cf. push.rs) ; on ne la réintroduit pas pour du courriel. IMAP est un
//! protocole de lignes : ce qui suit en implémente le strict nécessaire —
//! LOGIN, SELECT, FETCH d'un intervalle, STORE d'un drapeau — et rien d'autre.
//!
//! Limites assumées de cette première version, écrites ici pour qu'elles ne
//! soient pas découvertes à l'usage :
//!   * TLS implicite obligatoire (port 993). Pas de STARTTLS côté IMAP.
//!   * Mot de passe (ou mot de passe d'application) uniquement : pas d'OAuth.
//!     Gmail et Outlook demandent donc un mot de passe d'application.
//!   * INBOX seule, pas de dossiers.
//!   * Corps texte : la première partie `text/plain` (ou l'HTML détagué à
//!     défaut). Les pièces jointes sont signalées, pas téléchargées.
//!
//! Le mot de passe vit dans `mail-account.json`, à côté des autres secrets du
//! poste, et ne REMONTE JAMAIS à la WebView : `mail_account_get` renvoie un
//! booléen `has_password`, jamais la valeur.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};

const MAX_MESSAGES: usize = 200;
// Assez pour la plupart des lettres d'information HTML (souvent 40–90 Ko) ;
// au-delà, le HTML tronqué reste affichable (le parseur du front le referme).
const BODY_PREVIEW_BYTES: usize = 96 * 1024;
const MAX_HTML_CHARS: usize = 150_000;

// ---------------------------------------------------------------------------
// Compte
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct MailAccount {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub imap_host: String,
    #[serde(default = "imap_port_default")]
    pub imap_port: u16,
    #[serde(default)]
    pub smtp_host: String,
    #[serde(default = "smtp_port_default")]
    pub smtp_port: u16,
    /// Identifiant de connexion, quand il diffère de l'adresse.
    #[serde(default)]
    pub user: String,
    /// Jamais sérialisé vers le front (cf. `mail_account_get`).
    #[serde(default)]
    pub password: String,
    /// 587 + STARTTLS (défaut) plutôt que 465 + TLS implicite.
    #[serde(default = "yes")]
    pub smtp_starttls: bool,
}
fn imap_port_default() -> u16 { 993 }
fn smtp_port_default() -> u16 { 587 }
fn yes() -> bool { true }

impl MailAccount {
    fn login(&self) -> &str {
        if self.user.is_empty() { &self.email } else { &self.user }
    }
    fn configured(&self) -> bool {
        !self.email.is_empty() && !self.imap_host.is_empty() && !self.password.is_empty()
    }
}

fn account_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mail-account.json"))
}

fn mailbox_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mail.json"))
}

fn read_account(app: &tauri::AppHandle) -> MailAccount {
    account_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct MailMessage {
    /// UID IMAP préfixé, stable d'une synchro à l'autre.
    pub id: String,
    #[serde(default)]
    pub uid: u32,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub date: String,
    /// Secondes epoch, pour le tri (0 si la date n'a pas pu être lue).
    #[serde(default)]
    pub ts: i64,
    #[serde(default)]
    pub body: String,
    /// Version HTML d'origine (décodée, NON assainie) quand le message en a
    /// une. Le front la nettoie et l'affiche dans une iframe sans script ni
    /// réseau (lib/mail-html.js) ; `body` reste la version texte de référence.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub html: String,
    #[serde(default)]
    pub read: bool,
    #[serde(default)]
    pub has_attachments: bool,
}

fn read_mailbox(app: &tauri::AppHandle) -> Vec<MailMessage> {
    mailbox_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_mailbox(app: &tauri::AppHandle, msgs: &[MailMessage]) -> Result<(), String> {
    let data = serde_json::to_string(msgs).map_err(|e| e.to_string())?;
    fs::write(mailbox_path(app)?, data).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Brouillons
// ---------------------------------------------------------------------------
//
// Un brouillon est ce qu'un agent a le droit de produire : un message ÉCRIT,
// jamais envoyé. Il vit dans son propre fichier, à part de la boîte reçue, et
// l'app Email l'ouvre dans le composeur — c'est un humain qui appuie sur
// « Envoyer ». Cf. la section « Outils IA » plus bas pour la règle complète.

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct MailDraft {
    pub id: String,
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub cc: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub body: String,
    /// Secondes epoch.
    #[serde(default)]
    pub ts: i64,
    /// Qui l'a écrit : "user" ou le nom de l'agent.
    #[serde(default)]
    pub author: String,
    /// UID du message auquel il répond, 0 si c'est un message neuf.
    #[serde(default)]
    pub in_reply_to: u32,
}

fn drafts_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mail-drafts.json"))
}

fn read_drafts(app: &tauri::AppHandle) -> Vec<MailDraft> {
    drafts_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_drafts(app: &tauri::AppHandle, drafts: &[MailDraft]) -> Result<(), String> {
    let data = serde_json::to_string(drafts).map_err(|e| e.to_string())?;
    fs::write(drafts_path(app)?, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mail_drafts_load(app: tauri::AppHandle) -> Result<String, String> {
    Ok(fs::read_to_string(drafts_path(&app)?).unwrap_or_default())
}

#[tauri::command(async)]
pub fn mail_drafts_save(app: tauri::AppHandle, data: String) -> Result<(), String> {
    serde_json::from_str::<Vec<MailDraft>>(&data)
        .map_err(|e| format!("Brouillons invalides : {e}"))?;
    fs::write(drafts_path(&app)?, data).map_err(|e| e.to_string())
}

/// Ajoute un brouillon. Appelé par l'outil IA `mail_write_draft` ET par l'app.
/// Borne à 100 : un agent en boucle ne doit pas remplir le disque.
pub fn add_draft(app: &tauri::AppHandle, mut draft: MailDraft) -> Result<String, String> {
    let mut all = read_drafts(app);
    if draft.id.is_empty() {
        draft.id = format!("draft-{}", now_secs());
    }
    if draft.ts == 0 {
        draft.ts = now_secs();
    }
    let id = draft.id.clone();
    all.retain(|d| d.id != id);
    all.insert(0, draft);
    all.truncate(100);
    write_drafts(app, &all)?;
    let _ = app.emit("mail-drafts-updated", ());
    Ok(id)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Outils IA
// ---------------------------------------------------------------------------
//
// RÈGLE, et elle n'est pas négociable côté modèle : un agent peut LIRE le
// courrier et ÉCRIRE des brouillons. Il ne peut ni envoyer, ni supprimer.
//
// Ce n'est pas une politique d'approbation qu'on pourrait desserrer dans une
// fiche d'agent : les fonctions correspondantes n'existent tout simplement pas
// dans le catalogue d'outils (cf. native_tools.rs). `mail_send` est une
// commande Tauri appelée par un CLIC dans l'app Email, jamais par `exec`. Un
// modèle qui « décide » d'envoyer un message ne trouve aucun outil pour le
// faire — c'est la seule garantie qui tienne quand le modèle se trompe.
//
// Les trois fonctions ci-dessous sont les points d'entrée exposés aux agents.

/// Liste les derniers messages (sans les corps) pour que le modèle choisisse.
pub fn tool_list(app: &tauri::AppHandle, limit: usize, unread_only: bool) -> String {
    let all = read_mailbox(app);
    let picked: Vec<&MailMessage> = all
        .iter()
        .filter(|m| !unread_only || !m.read)
        .take(limit.clamp(1, 50))
        .collect();
    if picked.is_empty() {
        return if unread_only {
            "Aucun message non lu.".into()
        } else {
            "La boîte de réception est vide. Relevez le courrier depuis l'app Email.".into()
        };
    }
    let mut out = format!("{} message(s) :\n", picked.len());
    for m in picked {
        out.push_str(&format!(
            "- uid {} · {} · de {} · « {} »{}\n",
            m.uid,
            if m.date.is_empty() { "date inconnue".into() } else { m.date.clone() },
            m.from,
            m.subject,
            if m.read { "" } else { " (non lu)" },
        ));
    }
    out.push_str("Utilise mail_read_message avec l'uid pour lire un message en entier.");
    out
}

/// Corps complet d'un message, par uid ou par bout d'objet.
/// Recherche plein texte dans le courrier relevé (objet, expéditeur, corps).
/// Chaque mot de la requête compte ; l'objet et l'expéditeur pèsent plus que
/// le corps. Renvoie les meilleurs messages avec un extrait autour du premier
/// mot trouvé.
pub fn tool_search(app: &tauri::AppHandle, query: &str, limit: usize) -> String {
    // Accents et casse repliés des deux côtés (« reunion » trouve « Réunion »),
    // mots vides écartés : « les », « des »… correspondaient à tous les messages.
    const STOP: &[&str] = &["les", "des", "une", "dans", "pour", "avec", "sur", "que", "qui", "est", "mes", "mon", "the", "and", "for", "with", "mail", "mails", "email", "emails", "message", "messages"];
    let words: Vec<String> = crate::session::fold(query)
        .split(|c: char| !c.is_alphanumeric() && c != '@' && c != '.')
        .map(|w| w.trim_matches('.'))
        .filter(|w| w.chars().count() >= 3 && !STOP.contains(w))
        .map(String::from)
        .collect();
    if words.is_empty() {
        return "Requête vide : précise ce qu'il faut chercher.".into();
    }
    let all = read_mailbox(app);
    let mut scored: Vec<(usize, &MailMessage)> = all
        .iter()
        .map(|m| {
            let head = crate::session::fold(&format!("{} {}", m.subject, m.from));
            let body = crate::session::fold(&m.body);
            let s = words.iter().map(|w| head.matches(w.as_str()).count() * 5 + body.matches(w.as_str()).count().min(5)).sum();
            (s, m)
        })
        .filter(|(s, _)| *s > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.ts.cmp(&a.1.ts)));
    if scored.is_empty() {
        return format!("Aucun message ne correspond à « {query} » (parmi {} relevés).", all.len());
    }
    let mut out = format!("{} message(s) pour « {query} » :\n", scored.len().min(limit));
    for (_, m) in scored.into_iter().take(limit.clamp(1, 20)) {
        let lower = m.body.to_lowercase();
        let at = words.iter().filter_map(|w| lower.find(w.as_str())).min().unwrap_or(0);
        // Extrait autour du premier mot trouvé, sur des frontières de caractère.
        // `at` vient de la copie en minuscules : ses octets peuvent ne pas tomber
        // sur une frontière de caractère de l'original (« İ » change de taille).
        let prefix = m.body.get(..at).unwrap_or("");
        let start = prefix.char_indices().rev().nth(80).map(|(i, _)| i).unwrap_or(0);
        let snippet: String = m.body[start..].chars().take(240).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
        out.push_str(&format!(
            "\n- uid {} · {} · de {} · « {} »\n  … {} …",
            m.uid, m.date, m.from, m.subject, snippet
        ));
    }
    out
}

/// Messages bruts pour un résumé côté front : les `uids` demandés, sinon les
/// `limit` plus récents (non lus seulement si demandé). Corps tronqués.
pub fn tool_bodies(app: &tauri::AppHandle, uids: &[u32], limit: usize, unread_only: bool) -> serde_json::Value {
    let all = read_mailbox(app);
    let picked: Vec<serde_json::Value> = all
        .iter()
        .filter(|m| if uids.is_empty() { !unread_only || !m.read } else { uids.contains(&m.uid) })
        .take(if uids.is_empty() { limit.clamp(1, 25) } else { uids.len() })
        .map(|m| serde_json::json!({
            "uid": m.uid, "from": m.from, "to": m.to, "subject": m.subject,
            "date": m.date, "read": m.read,
            "body": m.body.chars().take(2500).collect::<String>(),
        }))
        .collect();
    serde_json::Value::Array(picked)
}

/// Pont des outils « @mail_* » des barres de chat. Lecture et brouillons
/// seulement, comme pour les agents : l'envoi reste un geste de l'utilisateur.
#[tauri::command]
pub fn mail_chat_tool(app: tauri::AppHandle, action: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let n = |k: &str, d: u64| args.get(k).and_then(|v| v.as_u64()).unwrap_or(d);
    let b = |k: &str| args.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(match action.as_str() {
        "list" => serde_json::json!(tool_list(&app, n("limit", 10) as usize, b("unread_only"))),
        "search" => serde_json::json!(tool_search(&app, &s("query"), n("limit", 8) as usize)),
        "read" => serde_json::json!(tool_read(&app, n("uid", 0) as u32, &s("subject")).0),
        "bodies" => {
            let uids: Vec<u32> = args.get("uids").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_u64().map(|u| u as u32)).collect())
                .unwrap_or_default();
            tool_bodies(&app, &uids, n("limit", 10) as usize, b("unread_only"))
        }
        "draft" => {
            let (msg, ok) = tool_draft(&app, &s("to"), &s("subject"), &s("body"), n("reply_to_uid", 0) as u32, "Lumen");
            if !ok { return Err(msg); }
            serde_json::json!(msg)
        }
        other => return Err(format!("Action courrier inconnue : {other}")),
    })
}

pub fn tool_read(app: &tauri::AppHandle, uid: u32, subject: &str) -> (String, bool) {
    let all = read_mailbox(app);
    let needle = subject.trim().to_lowercase();
    let found = all
        .iter()
        .find(|m| (uid > 0 && m.uid == uid) || (!needle.is_empty() && m.subject.to_lowercase().contains(&needle)));
    match found {
        Some(m) => (
            format!(
                "De : {}\nÀ : {}\nDate : {}\nObjet : {}\n\n{}",
                m.from, m.to, m.date, m.subject, m.body
            ),
            true,
        ),
        None => (
            "Message introuvable. Appelle mail_list_messages pour voir les uid disponibles.".into(),
            false,
        ),
    }
}

/// Écrit un brouillon. N'envoie RIEN : c'est tout l'objet de cet outil.
pub fn tool_draft(
    app: &tauri::AppHandle,
    to: &str,
    subject: &str,
    body: &str,
    reply_to_uid: u32,
    author: &str,
) -> (String, bool) {
    if body.trim().is_empty() {
        return ("Brouillon vide : rien n'a été enregistré.".into(), false);
    }
    // Répondre à un message connu : le destinataire et l'objet se déduisent,
    // le modèle n'a pas à les recopier (et à se tromper en les recopiant).
    let mut to = to.trim().to_string();
    let mut subject = subject.trim().to_string();
    if reply_to_uid > 0 {
        if let Some(src) = read_mailbox(app).into_iter().find(|m| m.uid == reply_to_uid) {
            if to.is_empty() {
                to = src.from.clone();
            }
            if subject.is_empty() {
                subject = if src.subject.to_lowercase().starts_with("re:") {
                    src.subject.clone()
                } else {
                    format!("Re: {}", src.subject)
                };
            }
        }
    }
    let draft = MailDraft {
        id: String::new(),
        to,
        cc: String::new(),
        subject,
        body: body.to_string(),
        ts: 0,
        author: author.to_string(),
        in_reply_to: reply_to_uid,
    };
    match add_draft(app, draft) {
        Ok(_) => (
            "Brouillon enregistré dans l'app Email. Il n'a PAS été envoyé : l'utilisateur doit l'ouvrir, le relire et l'envoyer lui-même.".into(),
            true,
        ),
        Err(e) => (format!("Erreur : {e}"), false),
    }
}

// ---------------------------------------------------------------------------
// Transport TLS
// ---------------------------------------------------------------------------

/// Flux TLS vers `host:port`, racines webpki (aucun magasin système à charger).
fn tls_stream(host: &str, port: u16) -> Result<rustls::StreamOwned<rustls::ClientConnection, TcpStream>, String> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    // Tiberius also enables aws-lc-rs; select ring explicitly rather than
    // relying on rustls to infer a unique process-wide crypto provider.
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("Configuration TLS impossible : {e}"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    let server = rustls_pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| format!("Nom de serveur invalide : {host}"))?;
    let conn = rustls::ClientConnection::new(Arc::new(config), server)
        .map_err(|e| format!("TLS impossible : {e}"))?;
    let tcp = TcpStream::connect((host, port))
        .map_err(|e| format!("Connexion à {host}:{port} impossible : {e}"))?;
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(30))).ok();
    tcp.set_write_timeout(Some(std::time::Duration::from_secs(30))).ok();
    Ok(rustls::StreamOwned::new(conn, tcp))
}

// ---------------------------------------------------------------------------
// Client IMAP minimal
// ---------------------------------------------------------------------------

/// Une réponse IMAP : le texte, découpé autour de ses littéraux.
#[derive(Default, Clone)]
struct Response {
    segments: Vec<String>,
    literals: Vec<String>,
}

impl Response {
    /// Le texte de la réponse sans les littéraux : suffisant pour les
    /// réponses d'état (`* 12 EXISTS`, `a001 OK …`).
    fn text(&self) -> String { self.segments.join(" ") }
    /// Littéral annoncé par un segment contenant `marker`.
    fn literal_after(&self, marker: &str) -> Option<&str> {
        let i = self.segments.iter().position(|seg| seg.contains(marker))?;
        self.literals.get(i).map(String::as_str)
    }
}

struct Imap {
    stream: rustls::StreamOwned<rustls::ClientConnection, TcpStream>,
    buf: Vec<u8>,
    tag: u32,
}

impl Imap {
    fn connect(account: &MailAccount) -> Result<Self, String> {
        let stream = tls_stream(&account.imap_host, account.imap_port)?;
        let mut imap = Imap { stream, buf: Vec::new(), tag: 0 };
        imap.read_line()?; // salutation « * OK … »
        Ok(imap)
    }

    /// Une ligne de réponse, sans CRLF. Les littéraux sont lus par
    /// `read_exact` : ils ne passent jamais par ici.
    fn read_line(&mut self) -> Result<String, String> {
        loop {
            if let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = self.buf.drain(..=pos).collect();
                let s = String::from_utf8_lossy(&line);
                return Ok(s.trim_end_matches(['\r', '\n']).to_string());
            }
            let mut chunk = [0u8; 8192];
            let n = self.stream.read(&mut chunk).map_err(|e| format!("Lecture IMAP : {e}"))?;
            if n == 0 { return Err("Connexion IMAP fermée par le serveur.".into()); }
            self.buf.extend_from_slice(&chunk[..n]);
        }
    }

    fn read_exact(&mut self, n: usize) -> Result<Vec<u8>, String> {
        while self.buf.len() < n {
            let mut chunk = [0u8; 8192];
            let got = self.stream.read(&mut chunk).map_err(|e| format!("Lecture IMAP : {e}"))?;
            if got == 0 { return Err("Connexion IMAP fermée pendant un littéral.".into()); }
            self.buf.extend_from_slice(&chunk[..got]);
        }
        Ok(self.buf.drain(..n).collect())
    }

    /// Envoie une commande étiquetée et renvoie une réponse par ligne reçue.
    ///
    /// Les littéraux IMAP (`{n}` suivi de n octets bruts) contiennent des sauts
    /// de ligne : les recoller dans une seule chaîne rendait impossible de
    /// savoir où l'un finissait. Chaque réponse garde donc ses SEGMENTS de
    /// texte et ses LITTÉRAUX à part, `literals[i]` étant celui annoncé à la
    /// fin de `segments[i]`.
    fn command(&mut self, cmd: &str) -> Result<Vec<Response>, String> {
        self.tag += 1;
        let tag = format!("a{:03}", self.tag);
        let wire = format!("{tag} {cmd}\r\n");
        self.stream.write_all(wire.as_bytes()).map_err(|e| format!("Écriture IMAP : {e}"))?;
        self.stream.flush().ok();

        let mut out: Vec<Response> = Vec::new();
        loop {
            let mut resp = Response::default();
            let mut segment = self.read_line()?;
            while let Some(size) = literal_size(&segment) {
                let blob = self.read_exact(size)?;
                resp.segments.push(segment);
                resp.literals.push(String::from_utf8_lossy(&blob).to_string());
                // Ce qui suit le littéral reprend sur la ligne courante.
                segment = self.read_line()?;
            }
            resp.segments.push(segment);
            let head = resp.segments.first().cloned().unwrap_or_default();
            let finished = head.starts_with(&tag);
            let ok = finished && head[tag.len()..].trim_start().starts_with("OK");
            out.push(resp);
            if finished {
                if !ok { return Err(imap_error(&head)); }
                return Ok(out);
            }
        }
    }

    fn login(&mut self, account: &MailAccount) -> Result<(), String> {
        let cmd = format!("LOGIN {} {}", quote(account.login()), quote(&account.password));
        self.command(&cmd).map(|_| ())
    }

    /// Nombre de messages dans INBOX.
    fn select_inbox(&mut self) -> Result<u32, String> {
        let lines = self.command("SELECT INBOX")?;
        for resp in &lines {
            let l = resp.text();
            if let Some(rest) = l.strip_prefix("* ") {
                if let Some(n) = rest.strip_suffix(" EXISTS") {
                    return n.trim().parse::<u32>().map_err(|_| "Réponse EXISTS illisible.".to_string());
                }
            }
        }
        Ok(0)
    }

    fn logout(&mut self) { let _ = self.command("LOGOUT"); }
}

/// Taille du littéral annoncé en fin de ligne (« … {1234} »), s'il y en a un.
fn literal_size(line: &str) -> Option<usize> {
    let t = line.trim_end();
    if !t.ends_with('}') { return None; }
    let open = t.rfind('{')?;
    t[open + 1..t.len() - 1].trim_end_matches('+').parse().ok()
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Message d'erreur exploitable à partir d'une réponse IMAP `NO` / `BAD`.
fn imap_error(line: &str) -> String {
    let detail = line.split_once(' ').map(|(_, r)| r).unwrap_or(line).trim();
    if detail.to_uppercase().contains("AUTHENTICATIONFAILED") || detail.starts_with("NO [AUTH") {
        return "Identifiants refusés. Gmail et Outlook exigent un mot de passe d'application."
            .to_string();
    }
    format!("Le serveur IMAP a refusé : {detail}")
}

// ---------------------------------------------------------------------------
// Décodage MIME (juste ce qu'il faut pour afficher)
// ---------------------------------------------------------------------------

fn b64_decode(s: &str) -> Vec<u8> {
    use base64::Engine;
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .unwrap_or_default()
}

fn qp_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'=' if i + 1 < bytes.len() => {
                // `=` en fin de ligne : coupure douce, on saute le CRLF.
                if bytes[i + 1] == b'\r' || bytes[i + 1] == b'\n' {
                    i += if bytes[i + 1] == b'\r' { 3 } else { 2 };
                    continue;
                }
                if i + 2 < bytes.len() {
                    let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                    if let Ok(b) = u8::from_str_radix(hex, 16) { out.push(b); i += 3; continue; }
                }
                out.push(bytes[i]); i += 1;
            }
            b => { out.push(b); i += 1; }
        }
    }
    out
}

/// En-têtes encodés RFC 2047 (`=?UTF-8?B?…?=`). Les jeux de caractères autres
/// qu'UTF-8 et Latin-1 sont rendus au mieux plutôt que refusés.
fn decode_header(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find("=?") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        // La fin `?=` se cherche APRÈS « charset?encodage? » : en Q, le texte
        // commence souvent par « =C3… », et `Q?=` serait pris pour la fin.
        let skip = after.find('?').and_then(|a| after[a + 1..].find('?').map(|b| a + b + 2)).unwrap_or(0);
        let Some(end) = after[skip..].find("?=").map(|e| e + skip) else { out.push_str(&rest[start..]); return out.trim().to_string(); };
        let token = &after[..end];
        let parts: Vec<&str> = token.splitn(3, '?').collect();
        if parts.len() == 3 {
            let charset = parts[0].to_ascii_lowercase();
            let bytes = match parts[1].to_ascii_uppercase().as_str() {
                "B" => b64_decode(parts[2]),
                // En quoted-printable d'en-tête, `_` vaut l'espace.
                "Q" => qp_decode(&parts[2].replace('_', " ")),
                _ => parts[2].as_bytes().to_vec(),
            };
            out.push_str(&decode_bytes(&bytes, &charset));
        } else {
            out.push_str(&rest[start..start + 2 + end + 2]);
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_bytes(bytes: &[u8], charset: &str) -> String {
    if charset.contains("8859") || charset.contains("1252") {
        bytes.iter().map(|&b| b as char).collect()
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

fn strip_html(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    let mut skip_block = false;
    let lower = html.to_lowercase();
    let mut i = 0;
    let chars: Vec<char> = html.chars().collect();
    let lower_chars: Vec<char> = lower.chars().collect();
    while i < chars.len() {
        if !in_tag && chars[i] == '<' {
            let tail: String = lower_chars[i..(i + 8).min(lower_chars.len())].iter().collect();
            if tail.starts_with("<script") || tail.starts_with("<style") { skip_block = true; }
            if tail.starts_with("</script") || tail.starts_with("</style") { skip_block = false; }
            if tail.starts_with("<br") || tail.starts_with("</p") || tail.starts_with("</div") {
                out.push('\n');
            }
            in_tag = true;
        } else if in_tag && chars[i] == '>' {
            in_tag = false;
        } else if !in_tag && !skip_block {
            out.push(chars[i]);
        }
        i += 1;
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// Extrait un corps lisible d'un message brut (en-têtes + corps).
/// Renvoie `(texte, pièces_jointes_présentes)`. Seuls les tests s'en servent.
#[cfg(test)]
fn extract_body(raw: &str) -> (String, bool) {
    let (text, _, attach) = extract_parts(raw);
    (text, attach)
}

/// Texte lisible, HTML d'origine (vide s'il n'y en a pas) et présence de
/// pièces jointes. Le texte garde la priorité à `text/plain` ; à défaut, c'est
/// le HTML détagué.
fn extract_parts(raw: &str) -> (String, String, bool) {
    let (headers, body) = split_headers(raw);
    let boundary = header_param(&headers, "content-type", "boundary");
    let has_attach = raw.to_lowercase().contains("content-disposition: attachment");

    if let Some(boundary) = boundary {
        let sep = format!("--{boundary}");
        let mut plain: Option<String> = None;
        let mut html: Option<String> = None;
        for part in body.split(&sep) {
            let (ph, pb) = split_headers(part);
            let ctype = header_value(&ph, "content-type").to_lowercase();
            if ctype.contains("multipart/") {
                // Partie composite (alternative dans mixed) : on la redéplie.
                let (t, h, _) = extract_parts(part);
                if plain.is_none() && !t.trim().is_empty() { plain = Some(t); }
                if html.is_none() && !h.trim().is_empty() { html = Some(h); }
                continue;
            }
            if header_value(&ph, "content-disposition").to_lowercase().contains("attachment") { continue; }
            if ctype.contains("text/plain") && plain.is_none() {
                let t = decode_part(&ph, pb);
                if !t.trim().is_empty() { plain = Some(t); }
            } else if ctype.contains("text/html") && html.is_none() {
                html = Some(decode_part(&ph, pb));
            }
        }
        let html = html.unwrap_or_default();
        let text = plain.unwrap_or_else(|| strip_html(&html));
        return (text, html, has_attach);
    }

    let ctype = header_value(&headers, "content-type").to_lowercase();
    let decoded = decode_part(&headers, body);
    if ctype.contains("text/html") {
        (strip_html(&decoded), decoded, has_attach)
    } else {
        (decoded, String::new(), has_attach)
    }
}

fn decode_part(headers: &str, body: &str) -> String {
    let enc = header_value(headers, "content-transfer-encoding").to_lowercase();
    let charset = header_param(headers, "content-type", "charset").unwrap_or_else(|| "utf-8".into());
    let bytes = match enc.trim() {
        "base64" => b64_decode(body),
        "quoted-printable" => qp_decode(body),
        _ => body.as_bytes().to_vec(),
    };
    decode_bytes(&bytes, &charset.to_ascii_lowercase())
}

fn split_headers(raw: &str) -> (String, &str) {
    // Un message MIME sépare en-têtes et corps par une ligne vide. On accepte
    // les deux conventions de fin de ligne : certains serveurs renvoient du LF.
    for sep in ["\r\n\r\n", "\n\n"] {
        if let Some(pos) = raw.find(sep) {
            return (unfold(&raw[..pos]), &raw[pos + sep.len()..]);
        }
    }
    (unfold(raw), "")
}

/// Recolle les en-têtes repliés sur plusieurs lignes (RFC 5322, §2.2.3).
fn unfold(headers: &str) -> String {
    let mut out = String::new();
    for line in headers.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            out.push(' ');
            out.push_str(line.trim());
        } else {
            if !out.is_empty() { out.push('\n'); }
            out.push_str(line);
        }
    }
    out
}

fn header_value(headers: &str, name: &str) -> String {
    let want = format!("{}:", name.to_lowercase());
    headers
        .lines()
        .find(|l| l.to_lowercase().starts_with(&want))
        .map(|l| l[want.len()..].trim().to_string())
        .unwrap_or_default()
}

fn header_param(headers: &str, name: &str, param: &str) -> Option<String> {
    let value = header_value(headers, name);
    let lower = value.to_lowercase();
    let at = lower.find(&format!("{param}="))?;
    let rest = value[at + param.len() + 1..].trim();
    let rest = rest.strip_prefix('"').map(|r| r.split('"').next().unwrap_or(r))
        .unwrap_or_else(|| rest.split(&[';', ' '][..]).next().unwrap_or(rest));
    Some(rest.to_string())
}

/// Date RFC 5322 → secondes epoch. Le format est régulier ; `chrono` le lit.
fn parse_date(raw: &str) -> i64 {
    let raw = raw.trim();
    if let Ok(d) = chrono::DateTime::parse_from_rfc2822(raw) {
        return d.timestamp();
    }
    // `parse_from_rfc2822` VALIDE le jour de la semaine : un expéditeur qui se
    // trompe (ça arrive, et ce n'est pas notre problème) rendait le message
    // non daté, donc relégué en bas de la liste. On réessaie sans le jour.
    if let Some((_, rest)) = raw.split_once(", ") {
        if let Ok(d) = chrono::DateTime::parse_from_rfc2822(rest.trim()) {
            return d.timestamp();
        }
    }
    0
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

/// Compte configuré, SANS le mot de passe.
#[tauri::command]
pub fn mail_account_get(app: tauri::AppHandle) -> serde_json::Value {
    let a = read_account(&app);
    serde_json::json!({
        "email": a.email,
        "display_name": a.display_name,
        "imap_host": a.imap_host,
        "imap_port": a.imap_port,
        "smtp_host": a.smtp_host,
        "smtp_port": a.smtp_port,
        "user": a.user,
        "smtp_starttls": a.smtp_starttls,
        "has_password": !a.password.is_empty(),
        "configured": a.configured(),
    })
}

/// Enregistre le compte. Un `password` vide CONSERVE celui déjà en place :
/// l'interface ne le réaffiche jamais, elle ne peut donc pas le renvoyer.
#[tauri::command(async)]
pub fn mail_account_set(
    app: tauri::AppHandle,
    account: serde_json::Value,
    password: Option<String>,
) -> Result<(), String> {
    let mut next: MailAccount = serde_json::from_value(account).map_err(|e| e.to_string())?;
    let current = read_account(&app);
    next.password = match password {
        Some(p) if !p.is_empty() => p,
        _ => current.password,
    };
    let data = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
    fs::write(account_path(&app)?, data).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn mail_account_clear(app: tauri::AppHandle) -> Result<(), String> {
    let _ = fs::remove_file(account_path(&app)?);
    let _ = fs::remove_file(mailbox_path(&app)?);
    Ok(())
}

#[tauri::command]
pub fn mail_load(app: tauri::AppHandle) -> Result<String, String> {
    Ok(fs::read_to_string(mailbox_path(&app)?).unwrap_or_default())
}

/// Le front réécrit la boîte (lu/non lu, suppression locale).
#[tauri::command(async)]
pub fn mail_save(app: tauri::AppHandle, data: String) -> Result<(), String> {
    fs::write(mailbox_path(&app)?, data).map_err(|e| e.to_string())
}

/// Relève le courrier : les `limit` messages les plus récents d'INBOX.
///
/// Les drapeaux LOCAUX (lu) l'emportent sur ceux du serveur pour un message
/// déjà connu : marquer lu dans Lumen ne doit pas être défait par une synchro.
#[tauri::command(async)]
pub fn mail_sync(app: tauri::AppHandle, limit: Option<u32>) -> Result<usize, String> {
    let account = read_account(&app);
    if !account.configured() {
        return Err("Aucun compte de messagerie configuré.".into());
    }
    let limit = limit.unwrap_or(50).clamp(1, MAX_MESSAGES as u32);

    let mut imap = Imap::connect(&account)?;
    imap.login(&account)?;
    let total = imap.select_inbox()?;
    if total == 0 { imap.logout(); return Ok(0); }
    let first = total.saturating_sub(limit - 1).max(1);

    let lines = imap.command(&format!(
        "FETCH {first}:{total} (UID FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO DATE MIME-VERSION CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.{BODY_PREVIEW_BYTES}>)"
    ))?;
    imap.logout();

    let fetched = parse_fetch(&lines);
    let mut known = read_mailbox(&app);
    for m in fetched {
        match known.iter_mut().find(|k| k.uid == m.uid) {
            Some(existing) => {
                let read = existing.read || m.read;
                *existing = MailMessage { read, ..m };
            }
            None => known.push(m),
        }
    }
    known.sort_by(|a, b| b.ts.cmp(&a.ts));
    known.truncate(MAX_MESSAGES);
    let count = known.len();
    write_mailbox(&app, &known)?;
    Ok(count)
}

/// Reconstruit les messages à partir des lignes d'une réponse FETCH.
///
/// Chaque message arrive comme « * 12 FETCH (UID 34 FLAGS (\Seen) … {n} <en-têtes> … {m} <corps>) ».
/// `Imap::command` a déjà séparé texte et littéraux : il reste à relier chaque
/// littéral au champ qui l'annonçait.
fn parse_fetch(responses: &[Response]) -> Vec<MailMessage> {
    let mut out = Vec::new();
    for resp in responses {
        let text = resp.text();
        if !text.starts_with("* ") || !text.contains(" FETCH ") { continue; }
        let uid = capture_number(&text, "UID ").unwrap_or(0);
        if uid == 0 { continue; }
        let read = text.contains("\\Seen");

        // Chaque littéral est identifié par le champ qui l'annonce, et non par
        // sa position : un serveur peut réordonner les éléments du FETCH.
        let headers = resp.literal_after("HEADER.FIELDS").unwrap_or("");
        let body_raw = resp.literal_after("BODY[TEXT]").unwrap_or("");

        let headers = unfold(headers);
        let full = format!("{headers}\n\n{body_raw}");
        let (body, html, has_attachments) = extract_parts(&full);
        let date_raw = header_value(&headers, "date");
        out.push(MailMessage {
            id: format!("mail-{uid}"),
            uid,
            from: decode_header(&header_value(&headers, "from")),
            to: decode_header(&header_value(&headers, "to")),
            subject: decode_header(&header_value(&headers, "subject")),
            date: date_raw.clone(),
            ts: parse_date(&date_raw),
            body: body.trim().chars().take(20_000).collect(),
            html: html.chars().take(MAX_HTML_CHARS).collect(),
            read,
            has_attachments,
        });
    }
    out
}

fn capture_number(line: &str, key: &str) -> Option<u32> {
    let at = line.find(key)? + key.len();
    let rest = &line[at..];
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// Vérifie le compte de bout en bout sans rien relever : connexion, TLS,
/// identifiants. C'est le bouton « Tester » de l'app.
#[tauri::command(async)]
pub fn mail_test(app: tauri::AppHandle) -> Result<String, String> {
    let account = read_account(&app);
    if !account.configured() {
        return Err("Complétez l'adresse, le serveur IMAP et le mot de passe.".into());
    }
    let mut imap = Imap::connect(&account)?;
    imap.login(&account)?;
    let total = imap.select_inbox()?;
    imap.logout();
    Ok(format!("Connexion réussie — {total} message(s) dans la boîte de réception."))
}

/// Envoi SMTP. `lettre` construit le message et gère STARTTLS / TLS implicite.
#[tauri::command(async)]
pub fn mail_send(
    app: tauri::AppHandle,
    to: String,
    subject: String,
    body: String,
    cc: Option<String>,
) -> Result<(), String> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{Message, SmtpTransport, Transport};

    let account = read_account(&app);
    if account.email.is_empty() || account.smtp_host.is_empty() || account.password.is_empty() {
        return Err("Compte SMTP incomplet.".into());
    }
    let from = if account.display_name.is_empty() {
        account.email.clone()
    } else {
        format!("{} <{}>", account.display_name, account.email)
    };
    let mut builder = Message::builder()
        .from(from.parse().map_err(|e| format!("Expéditeur invalide : {e}"))?)
        .subject(subject);
    for addr in to.split(&[',', ';'][..]).map(str::trim).filter(|s| !s.is_empty()) {
        builder = builder.to(addr.parse().map_err(|e| format!("Destinataire « {addr} » invalide : {e}"))?);
    }
    for addr in cc.unwrap_or_default().split(&[',', ';'][..]).map(str::trim).filter(|s| !s.is_empty()) {
        builder = builder.cc(addr.parse().map_err(|e| format!("Copie « {addr} » invalide : {e}"))?);
    }
    let email = builder.body(body).map_err(|e| format!("Message invalide : {e}"))?;

    let creds = Credentials::new(account.login().to_string(), account.password.clone());
    let transport = if account.smtp_starttls {
        SmtpTransport::starttls_relay(&account.smtp_host)
    } else {
        SmtpTransport::relay(&account.smtp_host)
    }
    .map_err(|e| format!("SMTP indisponible : {e}"))?
    .port(account.smtp_port)
    .credentials(creds)
    .build();

    transport.send(&email).map_err(|e| format!("Envoi refusé : {e}"))?;
    Ok(())
}

/// Pièce jointe d'un envoi riche (contenu en base64).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAttachment {
    pub name: String,
    pub mime: String,
    pub data_b64: String,
}

/// Envoi SMTP « riche » : texte + HTML (alternative) et pièces jointes. Sert
/// aux rapports d'Analyse de données (envoi manuel et abonnements).
#[tauri::command(async)]
pub fn mail_send_rich(
    app: tauri::AppHandle,
    to: String,
    subject: String,
    text: String,
    html: Option<String>,
    cc: Option<String>,
    attachments: Option<Vec<MailAttachment>>,
) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use lettre::message::{header::ContentType, Attachment, MultiPart, SinglePart};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{Message, SmtpTransport, Transport};

    let account = read_account(&app);
    if account.email.is_empty() || account.smtp_host.is_empty() || account.password.is_empty() {
        return Err("Compte SMTP incomplet : configurez-le dans l'app Email.".into());
    }
    let from = if account.display_name.is_empty() {
        account.email.clone()
    } else {
        format!("{} <{}>", account.display_name, account.email)
    };
    let mut builder = Message::builder()
        .from(from.parse().map_err(|e| format!("Expéditeur invalide : {e}"))?)
        .subject(subject);
    let mut any_to = false;
    for addr in to.split(&[',', ';'][..]).map(str::trim).filter(|s| !s.is_empty()) {
        builder = builder.to(addr.parse().map_err(|e| format!("Destinataire « {addr} » invalide : {e}"))?);
        any_to = true;
    }
    if !any_to {
        return Err("Aucun destinataire.".into());
    }
    for addr in cc.unwrap_or_default().split(&[',', ';'][..]).map(str::trim).filter(|s| !s.is_empty()) {
        builder = builder.cc(addr.parse().map_err(|e| format!("Copie « {addr} » invalide : {e}"))?);
    }

    let body = match html.filter(|h| !h.trim().is_empty()) {
        Some(h) => MultiPart::alternative_plain_html(text, h),
        None => MultiPart::mixed().singlepart(SinglePart::plain(text)),
    };
    let mut mixed = MultiPart::mixed().multipart(body);
    let mut total = 0usize;
    for a in attachments.unwrap_or_default() {
        let bytes = STANDARD.decode(a.data_b64.as_bytes()).map_err(|e| format!("Pièce jointe « {} » illisible : {e}", a.name))?;
        total += bytes.len();
        if total > 20 * 1024 * 1024 {
            return Err("Pièces jointes trop lourdes (> 20 Mo).".into());
        }
        let ct = ContentType::parse(&a.mime).unwrap_or(ContentType::parse("application/octet-stream").unwrap());
        mixed = mixed.singlepart(Attachment::new(a.name).body(bytes, ct));
    }
    let email = builder.multipart(mixed).map_err(|e| format!("Message invalide : {e}"))?;

    let creds = Credentials::new(account.login().to_string(), account.password.clone());
    let transport = if account.smtp_starttls {
        SmtpTransport::starttls_relay(&account.smtp_host)
    } else {
        SmtpTransport::relay(&account.smtp_host)
    }
    .map_err(|e| format!("SMTP indisponible : {e}"))?
    .port(account.smtp_port)
    .credentials(creds)
    .build();

    transport.send(&email).map_err(|e| format!("Envoi refusé : {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_header_q_starting_with_escape() {
        assert_eq!(decode_header("=?UTF-8?Q?=C3=87a_part_vite?="), "Ça part vite");
    }

    #[test]
    fn qp_html_part_with_headers() {
        let raw = "Content-Type: multipart/alternative; boundary=\"b\"\n\n--b\nContent-Type: text/html; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\n<p style=3D\"x\">Salut</p>\n--b--";
        let (text, html, _) = extract_parts(raw);
        assert!(html.contains("style=\"x\""));
        assert!(text.contains("Salut"));
    }

    #[test]
    fn decode_rfc2047_headers() {
        assert_eq!(decode_header("=?UTF-8?B?Q29tcHRlIHJlbmR1IGRlIHLDqXVuaW9u?="), "Compte rendu de réunion");
        assert_eq!(decode_header("=?utf-8?Q?R=C3=A9union_de_lundi?="), "Réunion de lundi");
        assert_eq!(decode_header("Objet simple"), "Objet simple");
        // Deux mots encodés qui se suivent : RFC 2047 les recolle.
        assert_eq!(decode_header("=?UTF-8?B?QQ==?= =?UTF-8?B?Qg==?="), "A B");
    }

    #[test]
    fn literal_sizes() {
        assert_eq!(literal_size("* 1 FETCH (BODY[TEXT] {42}"), Some(42));
        assert_eq!(literal_size("* 1 FETCH (UID 7)"), None);
        assert_eq!(literal_size("+ ready {12+}"), Some(12));
    }

    #[test]
    fn plain_body_is_extracted_and_decoded() {
        let raw = "Subject: x\r\nContent-Type: text/plain; charset=utf-8\r\n\
                   Content-Transfer-Encoding: quoted-printable\r\n\r\nBonjour=20Mika=C3=ABl";
        let (body, attach) = extract_body(raw);
        assert_eq!(body, "Bonjour Mikaël");
        assert!(!attach);
    }

    #[test]
    fn multipart_keeps_html_alongside_text() {
        let raw = "Content-Type: multipart/alternative; boundary=SEP\r\n\r\n\
                   --SEP\r\nContent-Type: text/plain\r\n\r\nVersion texte\r\n\
                   --SEP\r\nContent-Type: text/html\r\n\r\n<p>Version <b>HTML</b></p>\r\n--SEP--";
        let (text, html, _) = extract_parts(raw);
        assert!(text.contains("Version texte"));
        assert!(html.contains("<b>HTML</b>"));
    }

    #[test]
    fn multipart_prefers_plain_over_html() {
        let raw = "Content-Type: multipart/alternative; boundary=\"SEP\"\r\n\r\n\
                   --SEP\r\nContent-Type: text/html\r\n\r\n<p>Version HTML</p>\r\n\
                   --SEP\r\nContent-Type: text/plain\r\n\r\nVersion texte\r\n--SEP--\r\n";
        let (body, _) = extract_body(raw);
        assert_eq!(body.trim(), "Version texte");
    }

    #[test]
    fn html_only_is_detagged() {
        let raw = "Content-Type: text/html; charset=utf-8\r\n\r\n\
                   <style>p{color:red}</style><p>Bonjour</p><p>Monde &amp; co</p>";
        let (body, _) = extract_body(raw);
        assert!(!body.contains("color:red"), "le CSS ne doit pas ressortir : {body}");
        assert!(body.contains("Bonjour"));
        assert!(body.contains("Monde & co"));
    }

    #[test]
    fn attachments_are_flagged_not_downloaded() {
        let raw = "Content-Type: multipart/mixed; boundary=\"B\"\r\n\r\n\
                   --B\r\nContent-Type: text/plain\r\n\r\nVoir pièce jointe\r\n\
                   --B\r\nContent-Type: application/pdf\r\n\
                   Content-Disposition: attachment; filename=\"x.pdf\"\r\n\r\nJVBERi0=\r\n--B--\r\n";
        let (body, attach) = extract_body(raw);
        assert_eq!(body.trim(), "Voir pièce jointe");
        assert!(attach);
    }

    #[test]
    fn folded_headers_are_rejoined() {
        let h = unfold("Subject: un objet\r\n  qui continue\r\nFrom: a@b.c");
        assert_eq!(header_value(&h, "subject"), "un objet qui continue");
        assert_eq!(header_value(&h, "from"), "a@b.c");
    }

    #[test]
    fn fetch_response_becomes_a_message() {
        // Forme produite par Imap::command : segments de texte et littéraux séparés.
        let resp = Response {
            segments: vec![
                "* 12 FETCH (UID 4242 FLAGS (\\Seen) BODY[HEADER.FIELDS (SUBJECT FROM TO DATE)] {90}".into(),
                " BODY[TEXT] {13}".into(),
                ")".into(),
            ],
            literals: vec![
                "Subject: Point d'avancement\r\nFrom: Ana <ana@exemple.fr>\r\nDate: Mon, 22 Sep 2026 09:30:00 +0200\r\n".into(),
                "Bonjour Mika".into(),
            ],
        };
        let msgs = parse_fetch(&[resp]);
        assert_eq!(msgs.len(), 1);
        let m = &msgs[0];
        assert_eq!(m.uid, 4242);
        assert!(m.read);
        assert_eq!(m.subject, "Point d'avancement");
        assert_eq!(m.from, "Ana <ana@exemple.fr>");
        assert!(m.ts > 0, "la date RFC 2822 doit être lue");
        // Même avec un jour de la semaine faux (22/09/2026 est un mardi).
        assert_eq!(m.ts, parse_date("Tue, 22 Sep 2026 09:30:00 +0200"));
        assert!(m.body.contains("Bonjour Mika"), "corps : {}", m.body);
    }

    #[test]
    fn quoting_protects_passwords_with_specials() {
        assert_eq!(quote(r#"a"b\c"#), r#""a\"b\\c""#);
    }
}
