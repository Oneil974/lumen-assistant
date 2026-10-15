//! RAG (Retrieval-Augmented Generation) local et portable.
//!
//! Base vectorielle **SQLite + sqlite-vec** (`app_data_dir/rag.db`) : aucune
//! dépendance système, fonctionne identiquement sur macOS / Linux / Windows /
//! Raspberry Pi (SQLite est compilé en dur, l'extension `vec0` chargée au
//! démarrage). Les embeddings sont calculés via le **même backend LLM que celui
//! choisi par l'utilisateur** (Ollama local par défaut, ou API OpenAI-compatible),
//! ce qui reste local-first.
//!
//! Pipeline : un document est découpé en *chunks* qui se chevauchent, chaque
//! chunk est encodé en vecteur, et la recherche encode la requête puis renvoie
//! les chunks les plus proches (similarité cosinus via `vec0`). L'IA de la barre
//! peut interroger cette base avec l'outil `search_documents`.
//!
//! Schéma :
//!   docs(doc_id TEXT PK, title, source, created_at)
//!   chunks(id INTEGER PK, doc_id, ordinal, text)         -- rowid = id
//!   vec_chunks USING vec0(embedding float[DIM])          -- rowid = chunks.id
//!   meta(key TEXT PK, value)                             -- embed_model / dim / backend

use std::path::{Path, PathBuf};
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::json;
use tauri::Manager;

const DEFAULT_OLLAMA_EMBED: &str = "nomic-embed-text";
const DEFAULT_OPENAI_EMBED: &str = "text-embedding-3-small";
/// Découpage par défaut (préréglage « moyen »). Les autres préréglages sont
/// définis dans `chunk_params`.
const CHUNK_CHARS: usize = 1000;
const CHUNK_OVERLAP: usize = 150;

/// Taille des chunks selon le préréglage choisi (stocké dans meta `chunk_preset`).
/// Volontairement réduit à 3 choix simples :
///   • « small »  → extraits courts, réponses précises (Q/R, fiches, annuaires).
///   • « medium » → équilibré (défaut).
///   • « large »  → extraits longs, conserve le contexte (prose, rapports).
fn chunk_params(conn: &Connection) -> (usize, usize) {
    match meta_get(conn, "chunk_preset").as_deref() {
        Some("small") => (500, 60),
        Some("large") => (1800, 260),
        _ => (CHUNK_CHARS, CHUNK_OVERLAP),
    }
}
/// La pertinence est jugée **relativement** au meilleur extrait de la requête
/// (voir `select_hits`) : l'échelle des similarités dépend du modèle
/// d'embedding, un seuil absolu ne survit pas à un changement d'encodeur.

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ===== Ouverture de la base + extension vectorielle =====

static VEC_INIT: Once = Once::new();

/// Enregistre l'extension `vec0` comme auto-extension SQLite (une seule fois pour
/// tout le process). Toute connexion ouverte ensuite y a accès.
fn ensure_vec_ext() {
    VEC_INIT.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("rag.db"))
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    ensure_vec_ext();
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS docs(
            doc_id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT, created_at INTEGER);
         CREATE TABLE IF NOT EXISTS chunks(
            id INTEGER PRIMARY KEY, doc_id TEXT NOT NULL, ordinal INTEGER, text TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
         CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
         -- Index plein-texte (FTS5) pour la recherche hybride par mot-clé.
         -- Deux colonnes : le texte de l'extrait ET le titre de son document.
         CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, title);",
    )
    .map_err(|e| e.to_string())?;
    migrate_fts_titles(&conn)?;
    // Auto-réparation : remplit l'index FTS pour les chunks qui n'y sont pas
    // encore (bases créées avant l'ajout de la recherche hybride).
    fill_missing_fts(&conn);
    Ok(conn)
}

/// Reconstruit l'index plein-texte quand il date d'avant la colonne `title`.
///
/// Sans titre indexé, « de quoi parle RESTAPIforBlackmagicCameras.pdf ? » ne
/// pouvait RIEN trouver : le nom du fichier n'apparaît nulle part dans le corps
/// du document. La reconstruction ne coûte rien — elle repart du texte déjà
/// stocké, sans réencoder le moindre vecteur.
fn migrate_fts_titles(conn: &Connection) -> Result<(), String> {
    let cols: i64 = conn
        .query_row("SELECT COUNT(*) FROM pragma_table_info('chunks_fts')", [], |r| r.get(0))
        .unwrap_or(0);
    if cols >= 2 {
        return Ok(());
    }
    conn.execute_batch(
        "DROP TABLE IF EXISTS chunks_fts;
         CREATE VIRTUAL TABLE chunks_fts USING fts5(text, title);",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Indexe dans FTS les extraits qui n'y sont pas (base neuve, migration, ou
/// import interrompu).
fn fill_missing_fts(conn: &Connection) {
    let Ok(mut stmt) = conn.prepare(
        "SELECT c.id, c.text, d.title FROM chunks c
         JOIN docs d ON d.doc_id = c.doc_id
         WHERE c.id NOT IN (SELECT rowid FROM chunks_fts)",
    ) else {
        return;
    };
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    });
    let Ok(rows) = rows else { return };
    for row in rows.flatten() {
        let (id, text, title) = row;
        let _ = conn.execute(
            "INSERT INTO chunks_fts(rowid, text, title) VALUES(?1, ?2, ?3)",
            rusqlite::params![id, text, searchable_title(&title)],
        );
    }
}

/// Titre rendu cherchable : le nom d'origine PLUS ses mots séparés.
///
/// « RESTAPIforBlackmagicCameras.pdf » donne aussi « REST API for Blackmagic
/// Cameras pdf ». Sans cette expansion, seul le nom de fichier tapé en entier
/// aurait pu correspondre — jamais « blackmagic » tout court, qui est pourtant
/// ce qu'un humain écrit.
fn searchable_title(title: &str) -> String {
    let mut out = String::from(title);
    out.push(' ');
    let mut prev_lower = false;
    for c in title.chars() {
        if c.is_alphanumeric() {
            // Frontière de casse (…APIfor → API for) : on coupe avant une
            // majuscule qui suit une minuscule.
            if c.is_uppercase() && prev_lower {
                out.push(' ');
            }
            out.push(c);
            prev_lower = c.is_lowercase() || c.is_numeric();
        } else {
            out.push(' ');
            prev_lower = false;
        }
    }
    out
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0))
        .ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Crée la table vectorielle à la bonne dimension au premier ajout, ou vérifie la
/// cohérence avec l'index existant. Renvoie une erreur explicite si on tente de
/// mélanger des modèles de dimensions différentes.
fn ensure_vec_table(
    conn: &Connection,
    dim: usize,
    model: &str,
    backend: &str,
) -> Result<(), String> {
    // Deux modèles peuvent partager la même dimension (1024 est courant) : sans
    // ce test, on mélangerait leurs vecteurs dans un même index, et la
    // recherche renverrait des résultats incohérents sans jamais rien signaler.
    if let Some(existing_model) = meta_get(conn, "embed_model") {
        if existing_model != model {
            return Err(format!(
                "La base de connaissances a été indexée avec « {existing_model} ». \
                 Videz l'index pour passer à « {model} »."
            ));
        }
    }
    match meta_get(conn, "embed_dim").and_then(|s| s.parse::<usize>().ok()) {
        Some(existing) if existing == dim => Ok(()),
        Some(existing) => Err(format!(
            "La base de connaissances utilise déjà des vecteurs de dimension {existing} (modèle « {} »). \
             Videz l'index pour changer de modèle d'embedding.",
            meta_get(conn, "embed_model").unwrap_or_default()
        )),
        None => {
            // Métrique cosinus : bien plus pertinente que L2 pour des embeddings
            // de texte, et permet un seuil de pertinence stable (cf. recherche).
            conn.execute_batch(&format!(
                "CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[{dim}] distance_metric=cosine);"
            ))
            .map_err(|e| e.to_string())?;
            meta_set(conn, "embed_dim", &dim.to_string())?;
            meta_set(conn, "embed_model", model)?;
            meta_set(conn, "embed_backend", backend)?;
            meta_set(conn, "embed_metric", "cosine")?;
            meta_set(conn, "embed_prefix_version", PREFIX_VERSION)?;
            Ok(())
        }
    }
}

// ===== Embeddings (Ollama / OpenAI-compatible) =====

struct Embedder {
    backend: String, // "ollama" | "openai" | "llama"
    base: String,    // url Ollama ou api_base OpenAI
    key: String,     // clé API (vide pour Ollama)
    model: String,
}

/// Résout l'encodeur d'embeddings depuis la config LLM de l'utilisateur. Réutilise
/// le modèle déjà stocké dans l'index si présent (cohérence ingestion/requête).
fn resolve_embedder(app: &tauri::AppHandle, conn: &Connection) -> Embedder {
    let cfg = crate::agents::read_llm_config(app);
    let is_api = cfg.backend == "api" && !cfg.api_key.is_empty();
    let stored = meta_get(conn, "embed_model");
    // Préférence explicite : un GGUF d'embedding servi par notre propre
    // llama-server. Elle prime sur la source de discussion — on peut très bien
    // discuter avec une API cloud et encoder ses documents en local, ce qui
    // évite d'envoyer un document entier chez un fournisseur.
    if let Some(gguf) = embed_pref(conn) {
        return Embedder {
            backend: "llama".into(),
            base: format!("http://127.0.0.1:{}/v1", crate::llama::EMBED_PORT),
            key: String::new(),
            model: gguf,
        };
    }
    // Mode « automatique » : l'encodeur suit la source de discussion. Cela n'a
    // de sens que pour une API (qui expose /v1/embeddings) ou pour Ollama, qui
    // tourne alors forcément. Avec llama.cpp local ou le Raccourci Apple, rien
    // ne garantit qu'un Ollama existe sur la machine : lui envoyer les
    // embeddings donnait « Ollama injoignable : Connection refused » sur l'URL
    // d'Ollama, alors que Lumen sait encoder en local. On préfère donc un GGUF
    // d'embedding déjà téléchargé — sauf si l'index est déjà verrouillé sur un
    // autre encodeur, auquel cas basculer ne produirait qu'une erreur de
    // dimension, moins claire que de rester sur le modèle d'origine.
    if let Some(gguf) = auto_local_embedder(
        &cfg.backend,
        is_api,
        stored.as_deref(),
        || crate::llama::first_installed_embed_model(app),
    ) {
        return Embedder {
            backend: "llama".into(),
            base: format!("http://127.0.0.1:{}/v1", crate::llama::EMBED_PORT),
            key: String::new(),
            model: gguf,
        };
    }
    if is_api {
        Embedder {
            backend: "openai".into(),
            base: if cfg.api_base.trim().is_empty() {
                "https://api.openai.com/v1".into()
            } else {
                cfg.api_base.trim_end_matches('/').to_string()
            },
            key: cfg.api_key,
            model: stored.unwrap_or_else(|| DEFAULT_OPENAI_EMBED.into()),
        }
    } else {
        Embedder {
            backend: "ollama".into(),
            base: if cfg.url.trim().is_empty() {
                "http://localhost:11434".into()
            } else {
                cfg.url.trim_end_matches('/').to_string()
            },
            key: String::new(),
            model: stored.unwrap_or_else(|| DEFAULT_OLLAMA_EMBED.into()),
        }
    }
}

/// Décision du mode « automatique » : faut-il encoder avec un GGUF local ?
///
/// `installed` est paresseux — inutile de balayer le dossier des modèles quand
/// la source de discussion répond déjà de l'encodage.
fn auto_local_embedder(
    chat_backend: &str,
    is_api: bool,
    indexed_with: Option<&str>,
    installed: impl FnOnce() -> Option<String>,
) -> Option<String> {
    if is_api || chat_backend == "ollama" {
        return None;
    }
    let gguf = installed()?;
    // Index déjà verrouillé sur un autre encodeur : basculer ne produirait
    // qu'une erreur de dimension à la première insertion.
    match indexed_with {
        Some(m) if m != gguf => None,
        _ => Some(gguf),
    }
}

/// Modèle GGUF d'embedding choisi dans les Réglages, s'il y en a un.
///
/// Stocké à part de `embed_model` : ce dernier décrit l'index EXISTANT (et
/// verrouille sa dimension), alors que la préférence décrit ce que
/// l'utilisateur veut pour la suite. Les confondre rendait impossible de
/// détecter un changement de modèle.
fn embed_pref(conn: &Connection) -> Option<String> {
    let v = meta_get(conn, "embed_pref")?;
    let v = v.trim().to_string();
    if v.is_empty() || v == "auto" {
        None
    } else {
        Some(v)
    }
}

/// Démarre le serveur d'embeddings si l'encodeur choisi en dépend. Appelé
/// depuis du code bloquant (ingestion, recherche), jamais depuis l'async.
fn ensure_embedder_ready(app: &tauri::AppHandle, emb: &Embedder) -> Result<(), String> {
    if emb.backend != "llama" {
        return Ok(());
    }
    crate::llama::ensure_embed_running_blocking(app, &emb.model)
}

fn http_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

/// Préfixe de tâche attendu par certains modèles (nomic-embed-text) : la requête
/// et les documents doivent être marqués distinctement, sinon la similarité est
/// « molle » (tout se ressemble). Sans effet pour les modèles qui n'en ont pas
/// besoin (OpenAI, mxbai…).
fn task_prefix(model: &str, role: Role) -> &'static str {
    let m = model.to_lowercase();
    if m.contains("nomic") {
        return match role {
            Role::Query => "search_query: ",
            Role::Document => "search_document: ",
        };
    }
    // LFM2.5-Embedding est entraîné AVEC ces préfixes (prompt_name query /
    // document côté sentence-transformers). Les omettre ne provoque aucune
    // erreur : la similarité s'effondre simplement, sans rien signaler — c'est
    // ce qui rendait les scores vectoriels si bas qu'aucun extrait ne passait
    // le seuil, et que seule la recherche par mot-clé remontait quoi que ce soit.
    if m.contains("lfm2") {
        return match role {
            Role::Query => "query: ",
            Role::Document => "document: ",
        };
    }
    // EmbeddingGemma : invites de tâche documentées par Google (recherche).
    if m.contains("embeddinggemma") {
        return match role {
            Role::Query => "task: search result | query: ",
            Role::Document => "title: none | text: ",
        };
    }
    // Qwen3-Embedding : instruction côté requête uniquement, les passages
    // partent nus (usage documenté du modèle).
    if m.contains("qwen3-embedding") {
        return match role {
            Role::Query => "Instruct: Given a search query, retrieve relevant passages that answer it\nQuery: ",
            Role::Document => "",
        };
    }
    ""
}

/// Version du protocole d'encodage (préfixes de tâche compris). À incrémenter
/// dès qu'un changement rend les vecteurs existants incomparables aux nouveaux :
/// `status()` s'en sert pour proposer une réindexation, faute de quoi une
/// requête préfixée serait comparée à des documents encodés sans préfixe.
const PREFIX_VERSION: &str = "3";

#[derive(Clone, Copy)]
enum Role {
    Query,
    Document,
}

/// Échec d'encodage, avec l'information qui décide de la suite : un serveur qui
/// charge encore son modèle (503) mérite une nouvelle tentative, un modèle
/// absent non.
struct EmbedError {
    msg: String,
    retryable: bool,
}

impl From<String> for EmbedError {
    fn from(msg: String) -> Self {
        EmbedError { msg, retryable: false }
    }
}

/// Encode un texte, en patientant si le serveur n'est pas encore prêt.
///
/// llama-server répond 503 tant qu'il charge le modèle, et Ollama fait de même
/// au premier appel après un démarrage à froid. La toute première indexation
/// tombait donc sur « 503 » alors qu'il suffisait d'attendre quelques secondes.
/// L'attente de disponibilité est déjà faite au démarrage du serveur
/// (`wait_embed_ready`) ; ce filet couvre le reste : Ollama, une API distante
/// qui limite le débit, un serveur relancé entre deux chunks.
fn embed(emb: &Embedder, text: &str, role: Role) -> Result<Vec<f32>, String> {
    embed_retrying(emb, text, role).map_err(|e| e.msg)
}

fn embed_retrying(emb: &Embedder, text: &str, role: Role) -> Result<Vec<f32>, EmbedError> {
    const ATTEMPTS: usize = 6;
    let mut wait = std::time::Duration::from_millis(400);
    for attempt in 1..=ATTEMPTS {
        match embed_once(emb, text, role) {
            Ok(v) => return Ok(v),
            Err(e) if e.retryable && attempt < ATTEMPTS => {
                std::thread::sleep(wait);
                // Progression douce : ~0,4 s puis 0,8, 1,6, 3,2, 6,4 → une
                // vingtaine de secondes de patience au total, sans marteler.
                wait *= 2;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!("la boucle rend la main à la dernière tentative")
}

/// Une tentative d'encodage. Bloquant (réseau) : à appeler hors runtime async.
/// `role` distingue requête et document (préfixes de tâche selon le modèle).
fn embed_once(emb: &Embedder, text: &str, role: Role) -> Result<Vec<f32>, EmbedError> {
    let prefixed = format!("{}{}", task_prefix(&emb.model, role), text);
    let text = prefixed.as_str();
    let client = http_client();
    if emb.backend == "llama" {
        // llama-server expose /v1/embeddings au format OpenAI, sans clé.
        let url = format!("{}/embeddings", emb.base);
        let resp = client
            .post(&url)
            .json(&json!({ "model": emb.model, "input": text }))
            .send()
            .map_err(|e| EmbedError {
                msg: format!("Serveur d'embeddings injoignable : {e}"),
                // Le serveur peut être en train d'ouvrir son port.
                retryable: true,
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            return Err(EmbedError {
                msg: format!("Serveur d'embeddings ({}) : {}", emb.model, status),
                retryable: is_transient(status),
            });
        }
        let v: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        return extract_vec(&v["data"][0]["embedding"]).map_err(EmbedError::from);
    }
    if emb.backend == "openai" {
        let url = format!("{}/embeddings", emb.base);
        let resp = client
            .post(&url)
            .bearer_auth(&emb.key)
            .json(&json!({ "model": emb.model, "input": text }))
            .send()
            .map_err(|e| EmbedError { msg: format!("Embeddings API injoignable : {e}"), retryable: true })?;
        if !resp.status().is_success() {
            let status = resp.status();
            return Err(EmbedError {
                msg: format!("Embeddings API : {status}"),
                retryable: is_transient(status),
            });
        }
        let v: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        extract_vec(&v["data"][0]["embedding"]).map_err(EmbedError::from)
    } else {
        let url = format!("{}/api/embeddings", emb.base);
        let resp = client
            .post(&url)
            .json(&json!({ "model": emb.model, "prompt": text }))
            .send()
            // L'URL dans le message : sans elle, « Ollama injoignable » sur une
            // machine sans Ollama laissait croire que le serveur d'embeddings
            // local était en cause.
            .map_err(|e| EmbedError {
                msg: format!(
                    "Ollama injoignable ({}) : {e}. Sans Ollama, choisissez un encodeur local \
                     dans Réglages → Modèles → « Embeddings (documents) ».",
                    emb.base
                ),
                retryable: true,
            })?;
        if !resp.status().is_success() {
            let status = resp.status();
            return Err(EmbedError {
                msg: format!(
                    "Ollama embeddings : {} (le modèle « {}» est-il installé ? `ollama pull {}`)",
                    status, emb.model, emb.model
                ),
                retryable: is_transient(status),
            });
        }
        let v: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        extract_vec(&v["embedding"]).map_err(EmbedError::from)
    }
}

/// Codes qui décrivent un serveur pas encore prêt (ou momentanément saturé)
/// plutôt qu'une erreur de configuration : il vaut la peine de réessayer.
/// 503 est celui de llama-server pendant le chargement du modèle.
fn is_transient(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 502 | 503 | 504)
}

fn extract_vec(v: &serde_json::Value) -> Result<Vec<f32>, String> {
    let arr = v.as_array().ok_or("réponse d'embedding invalide")?;
    if arr.is_empty() {
        return Err("vecteur d'embedding vide".into());
    }
    // Un vecteur par JETON au lieu d'un par extrait : le serveur n'applique
    // aucun pooling (métadonnée absente du GGUF, ou build qui la ignore). Le
    // dire franchement — sinon on stockerait des dimensions variables d'un
    // extrait à l'autre, et la recherche deviendrait incohérente sans erreur.
    if arr[0].is_array() {
        return Err(format!(
            "Le serveur d'embeddings renvoie {} vecteurs (un par jeton) au lieu d'un seul : \
             ce modèle n'expose pas de pooling. Choisissez un autre encodeur dans \
             Réglages → Modèles → « Embeddings (documents) ».",
            arr.len()
        ));
    }
    let out: Vec<f32> = arr
        .iter()
        .map(|x| x.as_f64().unwrap_or(0.0) as f32)
        .collect();
    // NaN et l'infini se glissent ici quand l'encodeur déraille (build CPU
    // fautif, modèle corrompu, valeur hors bornes du f32). Ils ne sont pas
    // représentables en JSON : plus loin, sqlite-vec rejetait l'insertion avec
    // un « JSON parsing error » qui ne désignait pas le coupable.
    let bad = out.iter().filter(|x| !x.is_finite()).count();
    if bad > 0 {
        return Err(format!(
            "L'encodeur a renvoyé {bad} valeur(s) non finies (NaN ou infini) sur {} : \
             le modèle d'embedding ou son moteur est en cause. Essayez un autre encodeur \
             dans Réglages → Modèles → « Embeddings (documents) », ou retéléchargez le modèle.",
            out.len()
        ));
    }
    Ok(out)
}

/// Vecteur f32 → BLOB little-endian, la forme binaire attendue par vec0.
///
/// Surtout PAS de texte JSON. sqlite-vec relit ce texte avec les conversions
/// numériques de la bibliothèque C, qui suivent la locale du processus — et sur
/// Linux, GTK (WebKitGTK, sous Tauri) appelle `setlocale(LC_ALL, "")` au
/// démarrage. En locale française, le séparateur décimal devient la virgule,
/// « 0.5 » n'est plus un nombre, et l'insertion échouait sur un « JSON parsing
/// error » impossible à relier à sa cause. macOS et Windows, eux, restaient en
/// locale C : le même code marchait, ce qui rendait le bug incompréhensible.
///
/// Le binaire ne s'analyse pas : il est indifférent à la locale, au format des
/// nombres, et plus rapide à insérer.
fn vec_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        // Les valeurs non finies n'ont pas de représentation utile dans un
        // index : `extract_vec` les refuse déjà en amont, on les neutralise ici
        // par sécurité plutôt que d'écrire un NaN dans la base.
        let x = if x.is_finite() { *x } else { 0.0 };
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

// ===== Découpage en chunks =====

/// Découpe un texte en chunks d'environ `size` caractères avec `overlap` de
/// chevauchement.
fn chunk_text(text: &str, size: usize, overlap: usize) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return vec![];
    }
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= size {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let step = size.saturating_sub(overlap).max(1);
    let mut start = 0;
    while start < chars.len() {
        let end = (start + size).min(chars.len());
        let slice: String = chars[start..end].iter().collect();
        let trimmed = slice.trim();
        if !trimmed.is_empty() {
            chunks.push(trimmed.to_string());
        }
        if end == chars.len() {
            break;
        }
        start += step;
    }
    chunks
}

// ===== Extraction de texte (fichiers) =====

fn extract_file_text(path: &Path) -> Result<String, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "pdf" {
        let text = pdf_extract::extract_text(path)
            .map_err(|e| format!("Extraction PDF impossible : {e}"))?;
        return check_pdf_text(text);
    }
    if ext == "docx" {
        let bytes = std::fs::read(path).map_err(|e| format!("Lecture impossible : {e}"))?;
        return extract_docx_text(&bytes);
    }
    // Texte / Markdown / code / CSV / JSON : lecture directe.
    std::fs::read_to_string(path).map_err(|e| format!("Lecture impossible : {e}"))
}

/// Extraction depuis des octets en mémoire (fichier déposé dans la webview),
/// aiguillée par l'extension du nom d'origine.
pub fn extract_bytes_text(title: &str, bytes: &[u8]) -> Result<String, String> {
    let lower = title.to_lowercase();
    if lower.ends_with(".pdf") {
        return check_pdf_text(extract_pdf_text(bytes)?);
    }
    if lower.ends_with(".docx") {
        return extract_docx_text(bytes);
    }
    if lower.ends_with(".doc") {
        return Err("Format .doc (Word 97) non pris en charge : enregistrez le fichier en .docx.".into());
    }
    Ok(String::from_utf8_lossy(bytes).to_string())
}

/// Nombre de LETTRES d'un texte. C'est l'unité de comparaison entre deux
/// extracteurs : un défaut de correspondance glyphe → Unicode en fait toujours
/// disparaître, jamais apparaître. Les espaces et la ponctuation, eux, varient
/// d'un extracteur à l'autre sans que le contenu change.
fn letter_count(text: &str) -> usize {
    text.chars().filter(|c| c.is_alphabetic()).count()
}

/// Texte d'un PDF, par le meilleur des deux extracteurs disponibles.
///
/// `pdf-extract` restitue mieux la mise en page, mais il construit sa table de
/// caractères depuis l'encodage interne des polices Type 1C : quand une police
/// est sous-ensemblée avec un encodage personnalisé, il perd les glyphes qu'il
/// n'y retrouve pas. Constaté sur la documentation REST des caméras Blackmagic,
/// dont le corps de texte est en ProximaNova-Regular : « The response is JSON »
/// en ressortait « e response is Jⁿ » — le document s'indexait, mais aucune
/// recherche ne pouvait plus le retrouver.
///
/// `lopdf`, lui, passe par le CMap ToUnicode du PDF, qui est correct dans ce
/// cas. Aucun des deux n'est meilleur partout : on prend donc les deux et on
/// garde le texte qui contient le plus de lettres.
///
/// `catch_unwind` : `pdf_extract` déréférence sans ménagement (`unwrap()`) sur
/// des PDF inhabituels. Une panique ne doit pas emporter l'ingestion alors
/// qu'un second extracteur attend son tour.
pub(crate) fn extract_pdf_text(bytes: &[u8]) -> Result<String, String> {
    let primary = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(bytes))
        .unwrap_or_else(|_| Err(pdf_extract::OutputError::from(std::io::Error::other(
            "pdf-extract a paniqué sur ce document",
        ))))
        .ok();

    let fallback = std::panic::catch_unwind(|| {
        let doc = lopdf::Document::load_mem(bytes).map_err(|e| e.to_string())?;
        let pages: Vec<u32> = doc.get_pages().keys().copied().collect();
        doc.extract_text(&pages).map_err(|e| e.to_string())
    })
    .unwrap_or_else(|_| Err("lopdf a paniqué sur ce document".to_string()))
    .ok();

    match (primary, fallback) {
        (Some(a), Some(b)) => {
            // Marge de 5 % : à égalité on garde `pdf-extract`, dont les
            // césures et les sauts de ligne sont plus fidèles au document.
            let keep_fallback = letter_count(&b) > letter_count(&a) * 105 / 100;
            Ok(if keep_fallback { b } else { a })
        }
        (Some(a), None) => Ok(a),
        (None, Some(b)) => Ok(b),
        (None, None) => Err("Extraction PDF impossible : aucun extracteur n'a pu lire ce fichier.".into()),
    }
}

/// Un PDF scanné n'a aucune couche texte : `pdf_extract` renvoie alors une
/// chaîne vide ou quelques caractères parasites. Le dire franchement vaut mieux
/// qu'indexer un document creux que l'utilisateur croira consultable.
fn check_pdf_text(text: String) -> Result<String, String> {
    if text.trim().chars().count() < 20 {
        return Err(
            "Ce PDF ne contient pas de texte extractible (document scanné ?). \
             Lumen ne fait pas de reconnaissance optique."
                .into(),
        );
    }
    Ok(text)
}

/// Texte d'un .docx — c'est un ZIP dont `word/document.xml` porte le contenu.
///
/// Analyse volontairement minimale (pas de crate XML) : on ne retient que les
/// `<w:t>` (texte courant) et on coupe une ligne à chaque fin de paragraphe.
/// Styles, tableaux et notes ne sont pas restitués ; pour du RAG, seul le flux
/// de texte compte.
fn extract_docx_text(bytes: &[u8]) -> Result<String, String> {
    use std::io::Read as _;
    let cursor = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("Fichier .docx illisible : {e}"))?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .map_err(|_| "Archive .docx sans word/document.xml".to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| format!("Contenu .docx illisible : {e}"))?;

    let mut out = String::new();
    let bytes = xml.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let Some(close) = xml[i..].find('>').map(|o| i + o) else { break };
        let tag = &xml[i + 1..close];
        // Une balise fermante commence par '/' : sans ce test, découper sur '/'
        // donnait un nom vide et les fins de paragraphe passaient inaperçues.
        let closing = tag.starts_with('/');
        let name = tag
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("");
        if name == "w:t" && !closing && !tag.ends_with('/') {
            let start = close + 1;
            let Some(end) = xml[start..].find("</w:t>").map(|o| start + o) else { break };
            out.push_str(&unescape_xml(&xml[start..end]));
            i = end + "</w:t>".len();
            continue;
        }
        if closing && name == "w:p" {
            out.push('\n');
        } else if !closing && (name == "w:br" || name == "w:tab") {
            out.push(if name == "w:tab" { '\t' } else { '\n' });
        }
        i = close + 1;
    }
    let text = out.trim().to_string();
    if text.is_empty() {
        return Err("Document .docx sans texte exploitable.".into());
    }
    Ok(text)
}

fn unescape_xml(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

// ===== Lecture documentaire (outils d'agent) =====

/// Extensions dont le contenu est du texte, mais empaqueté dans un format que
/// `read_to_string` ne sait pas lire. `extract_document_text` sait les ouvrir.
pub const RICH_DOC_EXTS: &[&str] = &["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "html", "htm"];

/// Extensions d'image : illisibles en texte, mais descriptibles par un modèle
/// vision (cf. `crate::agents::describe_image`).
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];

pub fn ext_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// Texte d'un document, quel que soit son emballage : PDF, Word, Excel,
/// PowerPoint, OpenDocument, HTML — sinon lecture texte directe.
///
/// C'est le point d'entrée des outils d'agent : un agent qui tombe sur un CV en
/// PDF ou un tableau .xlsx doit pouvoir le LIRE, pas se voir répondre
/// « fichier binaire ». Les formats non couverts remontent une erreur qui dit
/// quoi faire, plutôt qu'un flot d'octets illisible.
pub fn extract_document_text(name: &str, bytes: &[u8]) -> Result<String, String> {
    match ext_of(name).as_str() {
        "pdf" => check_pdf_text(extract_pdf_text(bytes)?),
        "docx" => extract_docx_text(bytes),
        // Classeurs : le texte des cellules vit dans `sharedStrings.xml` (chaînes
        // partagées) et dans les feuilles (nombres et chaînes en ligne).
        "xlsx" => zip_text(bytes, &["xl/sharedStrings.xml", "xl/worksheets/"], "xlsx"),
        "pptx" => zip_text(bytes, &["ppt/slides/slide"], "pptx"),
        // OpenDocument : un seul `content.xml` pour les trois familles.
        "odt" | "ods" | "odp" => zip_text(bytes, &["content.xml"], "OpenDocument"),
        "html" | "htm" => {
            let raw = String::from_utf8_lossy(bytes);
            let text = strip_markup(&raw);
            if text.trim().is_empty() {
                Err("Page HTML sans texte exploitable.".into())
            } else {
                Ok(text)
            }
        }
        "doc" => Err("Format .doc (Word 97) non pris en charge : enregistrez le fichier en .docx.".into()),
        _ => {
            let text = std::str::from_utf8(bytes)
                .map_err(|_| "Fichier binaire : contenu illisible en texte.".to_string())?;
            if text.contains('\0') {
                return Err("Fichier binaire : contenu illisible en texte.".into());
            }
            Ok(text.to_string())
        }
    }
}

/// Texte des entrées d'un ZIP dont le nom commence par l'un des `prefixes`
/// (formats Office/OpenDocument : ce sont des archives de XML).
fn zip_text(bytes: &[u8], prefixes: &[&str], label: &str) -> Result<String, String> {
    use std::io::Read as _;
    let cursor = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor).map_err(|e| format!("Fichier .{label} illisible : {e}"))?;
    // Tri par nom : les diapositives et les feuilles se lisent dans l'ordre du
    // document, pas dans celui — arbitraire — des entrées de l'archive.
    let mut names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| prefixes.iter().any(|p| n.starts_with(p)) && n.ends_with(".xml"))
        .collect();
    names.sort();
    let mut out = String::new();
    for name in names {
        let mut xml = String::new();
        if zip
            .by_name(&name)
            .ok()
            .and_then(|mut f| f.read_to_string(&mut xml).ok())
            .is_none()
        {
            continue;
        }
        let text = strip_markup(&xml);
        if text.trim().is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&text);
    }
    let text = out.trim().to_string();
    if text.is_empty() {
        return Err(format!("Document .{label} sans texte exploitable."));
    }
    Ok(text)
}

/// Ne garde que les nœuds texte d'un balisage XML/HTML, un blanc entre deux
/// balises. Volontairement sans crate XML : on cherche le flux de lecture, pas
/// une restitution fidèle. Le contenu des `<script>`/`<style>` est écarté, il
/// pollue plus qu'il n'informe.
fn strip_markup(markup: &str) -> String {
    let mut out = String::new();
    let bytes = markup.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let Some(close) = markup[i..].find('>').map(|o| i + o) else { break };
            let tag = markup[i + 1..close].trim_start_matches('/');
            let name = tag
                .split(|c: char| c.is_whitespace() || c == '/' || c == '>')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if !markup[i + 1..close].starts_with('/') && (name == "script" || name == "style") {
                let end_tag = format!("</{name}");
                i = markup[close..]
                    .find(&end_tag)
                    .map(|o| close + o)
                    .unwrap_or(bytes.len());
                continue;
            }
            // Une balise sépare deux mots : sans ce blanc, « <td>a</td><td>b</td> »
            // se lirait « ab ».
            if !out.ends_with(' ') && !out.ends_with('\n') {
                out.push(if name.starts_with("w:p")
                    || name == "p"
                    || name == "br"
                    || name == "tr"
                    || name.ends_with(":p")
                {
                    '\n'
                } else {
                    ' '
                });
            }
            i = close + 1;
            continue;
        }
        let Some(next) = markup[i..].find('<').map(|o| i + o) else {
            out.push_str(&unescape_xml(&markup[i..]));
            break;
        };
        out.push_str(&unescape_xml(&markup[i..next]));
        i = next;
    }
    out.split('\n')
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

// ===== Cœur : ingestion & recherche (sync, exécutés via spawn_blocking) =====

/// Texte réellement encodé : le titre du document précède l'extrait.
///
/// Un extrait isolé ne dit pas d'où il vient. « De quoi parle tel fichier ? »
/// ne pouvait donc ressembler à aucun vecteur, et une base de deux documents se
/// comportait comme si le second n'existait pas. Le titre reste hors du texte
/// stocké : il sert à la recherche, pas à l'affichage.
fn with_title(title: &str, text: &str) -> String {
    if title.trim().is_empty() {
        return text.to_string();
    }
    format!("{title}\n\n{text}")
}

/// Encode un chunk en acceptant qu'il soit trop long pour l'encodeur.
///
/// Un serveur d'embeddings refuse (ou tronque) une séquence plus longue que son
/// ubatch : jusqu'ici l'erreur remontait et l'ingestion s'arrêtait NET au milieu
/// du document — le PDF apparaissait indexé, mais amputé de tout ce qui suivait.
/// On coupe donc le chunk en deux et on réessaie, récursivement, jusqu'à une
/// taille plancher. Le texte n'est jamais perdu : il devient plusieurs extraits.
fn embed_chunk_resilient(
    emb: &Embedder,
    title: &str,
    text: &str,
    depth: usize,
) -> Result<Vec<(String, Vec<f32>)>, String> {
    match embed_retrying(emb, &with_title(title, text), Role::Document) {
        Ok(v) => Ok(vec![(text.to_string(), v)]),
        Err(e) => {
            // Serveur injoignable ou pas encore prêt : découper n'y changerait
            // rien et multiplierait les attentes. On remonte tout de suite.
            if e.retryable {
                return Err(e.msg);
            }
            let chars: Vec<char> = text.chars().collect();
            // Plancher : en dessous, l'échec ne vient plus de la longueur
            // (encodeur éteint, modèle absent…) et le masquer serait pire.
            if depth >= 4 || chars.len() < 200 {
                return Err(e.msg);
            }
            let mid = chars.len() / 2;
            let left: String = chars[..mid].iter().collect();
            let right: String = chars[mid..].iter().collect();
            let mut out = embed_chunk_resilient(emb, title, left.trim(), depth + 1)?;
            out.extend(embed_chunk_resilient(emb, title, right.trim(), depth + 1)?);
            Ok(out)
        }
    }
}

fn ingest_text(
    app: &tauri::AppHandle,
    title: &str,
    source: &str,
    text: &str,
) -> Result<serde_json::Value, String> {
    let conn = open(app)?;
    let (size, overlap) = chunk_params(&conn);
    let chunks = chunk_text(text, size, overlap);
    if chunks.is_empty() {
        return Err("Document vide : rien à indexer.".into());
    }
    let emb = resolve_embedder(app, &conn);
    ensure_embedder_ready(app, &emb)?;

    let doc_id = format!("doc-{}", now_ms());
    // Tout ou rien. Sans transaction, une panne d'encodeur au chunk 40 sur 120
    // laissait un document à moitié indexé, sans le dire : la recherche ne
    // trouvait jamais la fin du PDF et l'utilisateur ne pouvait pas le savoir.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let outcome = (|| -> Result<usize, String> {
        conn.execute(
            "INSERT INTO docs(doc_id,title,source,created_at) VALUES(?1,?2,?3,?4)",
            rusqlite::params![doc_id, title, source, now_ms() as i64],
        )
        .map_err(|e| e.to_string())?;

        let mut ordinal = 0usize;
        let mut first = true;
        for chunk in &chunks {
            for (piece, vector) in embed_chunk_resilient(&emb, title, chunk, 0)? {
                if first {
                    ensure_vec_table(&conn, vector.len(), &emb.model, &emb.backend)?;
                    first = false;
                }
                conn.execute(
                    "INSERT INTO chunks(doc_id,ordinal,text) VALUES(?1,?2,?3)",
                    rusqlite::params![doc_id, ordinal as i64, piece],
                )
                .map_err(|e| e.to_string())?;
                let rowid = conn.last_insert_rowid();
                conn.execute(
                    "INSERT INTO vec_chunks(rowid, embedding) VALUES(?1, ?2)",
                    rusqlite::params![rowid, vec_blob(&vector)],
                )
                .map_err(|e| format!("Insertion vectorielle : {e}"))?;
                let _ = conn.execute(
                    "INSERT INTO chunks_fts(rowid, text, title) VALUES(?1, ?2, ?3)",
                    rusqlite::params![rowid, piece, searchable_title(title)],
                );
                ordinal += 1;
            }
        }
        Ok(ordinal)
    })();

    match outcome {
        Ok(n) => {
            tx.commit().map_err(|e| e.to_string())?;
            Ok(json!({
                "doc_id": doc_id,
                "title": title,
                "chunks": n,
                // Nombre de caractères RÉELLEMENT indexés : c'est le seul moyen,
                // côté interface, de vérifier qu'un PDF est passé en entier.
                "chars": text.chars().count(),
            }))
        }
        Err(e) => {
            let _ = tx.rollback();
            Err(format!("Indexation interrompue, document non enregistré : {e}"))
        }
    }
}

#[derive(Serialize)]
struct Hit {
    text: String,
    title: String,
    doc_id: String,
    /// Identifiant de l'extrait (rowid) : permet à l'interface de dédoublonner
    /// et de citer deux fois le même document sans confondre ses passages.
    chunk_id: i64,
    /// Rang de l'extrait dans son document (utile pour « page/section ~ N »).
    ordinal: i64,
    distance: f64,
    /// Pertinence affichable, dans [0..1]. C'est la similarité cosinus quand
    /// l'extrait a un vecteur (le cas normal), sinon une valeur dérivée du
    /// score BM25. Sans elle, l'interface ne pouvait afficher qu'une distance
    /// brute — illisible — et les matches lexicaux passaient pour parfaits.
    score: f64,
    /// Vrai si l'extrait a été trouvé par mot-clé (FTS5) plutôt que par vecteur.
    lexical: bool,
}

/// Constante d'amortissement de la fusion RRF (valeur usuelle de la littérature).
/// Plus elle est grande, plus les rangs lointains pèsent.
const RRF_K: f64 = 60.0;

/// Vecteur stocké pour un extrait donné, relu depuis `vec_chunks`.
///
/// Sert à donner un score comparable aux extraits trouvés par mot-clé : sans
/// cela, un match FTS s'affichait à 100 % simplement parce qu'aucune distance
/// n'avait été calculée pour lui.
fn stored_vector(conn: &Connection, rowid: i64) -> Option<Vec<f32>> {
    let blob: Vec<u8> = conn
        .query_row("SELECT embedding FROM vec_chunks WHERE rowid=?1", [rowid], |r| r.get(0))
        .ok()?;
    if blob.len() % 4 != 0 || blob.is_empty() {
        return None;
    }
    Some(
        blob.chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect(),
    )
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> Option<f64> {
    if a.len() != b.len() || a.is_empty() {
        return None;
    }
    let (mut dot, mut na, mut nb) = (0f64, 0f64, 0f64);
    for (x, y) in a.iter().zip(b.iter()) {
        dot += (*x as f64) * (*y as f64);
        na += (*x as f64) * (*x as f64);
        nb += (*y as f64) * (*y as f64);
    }
    if na == 0.0 || nb == 0.0 {
        return None;
    }
    Some(dot / (na.sqrt() * nb.sqrt()))
}

/// Candidat intermédiaire de la recherche hybride, avant fusion des deux
/// classements.
struct Cand {
    hit: Hit,
    /// Rang (0-based) dans le classement lexical, s'il y figure.
    rank_lex: Option<usize>,
    /// Rang (0-based) dans le classement vectoriel, s'il y figure.
    rank_vec: Option<usize>,
}

impl Cand {
    /// Fusion de rangs réciproques : additionne 1/(K+rang) sur les classements
    /// où le candidat apparaît. Un extrait trouvé par les DEUX voies passe donc
    /// devant, ce qui est exactement le signal recherché.
    fn fused(&self) -> f64 {
        let f = |r: Option<usize>| r.map_or(0.0, |r| 1.0 / (RRF_K + r as f64 + 1.0));
        f(self.rank_lex) + f(self.rank_vec)
    }
}

/// Mots trop courants pour discriminer quoi que ce soit. Les garder revenait à
/// faire correspondre la question à TOUS les extraits du corpus : sur « de quoi
/// parle ce fichier ? », « de » et « quoi » ramenaient l'intégralité d'un
/// document et noyaient les vrais candidats.
const STOP_WORDS: &[&str] = &[
    // Français
    "au", "aux", "avec", "ce", "ces", "cet", "cette", "dans", "de", "des", "du", "elle", "en",
    "est", "et", "eux", "il", "ils", "je", "la", "le", "les", "leur", "lui", "ma", "mais", "me",
    "mes", "moi", "mon", "ne", "nos", "notre", "nous", "on", "ou", "par", "pas", "pour", "qu",
    "que", "quel", "quelle", "quelles", "quels", "qui", "quoi", "sa", "se", "ses", "son", "sur",
    "ta", "te", "tes", "toi", "ton", "tu", "un", "une", "vos", "votre", "vous", "y", "dit",
    "dire", "parle", "parlent", "peux", "peut", "veux", "veut", "fait", "faire", "sont", "été",
    "avoir", "être", "cela", "ceci", "donc", "alors",
    // Anglais
    "a", "about", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does", "for",
    "from", "has", "have", "how", "in", "is", "it", "its", "me", "my", "of", "on", "or", "our",
    "say", "says", "tell", "that", "the", "their", "them", "there", "they", "this", "to", "was",
    "we", "what", "which", "who", "will", "with", "you", "your",
];

/// Termes retenus pour la recherche par mot-clé, cités pour neutraliser la
/// syntaxe FTS.
///
/// Les mots vides sont écartés — sauf s'il ne reste rien, auquel cas mieux vaut
/// chercher avec eux que ne pas chercher du tout.
fn query_terms(query: &str) -> Vec<String> {
    let words: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| s.chars().count() >= 2)
        .map(|s| s.to_lowercase())
        .collect();
    let useful: Vec<String> = words
        .iter()
        .filter(|w| !STOP_WORDS.contains(&w.as_str()))
        .cloned()
        .collect();
    let kept = if useful.is_empty() { words } else { useful };
    kept.into_iter().map(|w| format!("\"{w}\"")).collect()
}

/// Ligne brute du classement lexical : (id, texte, titre du document, doc_id,
/// ordinal, score BM25).
type LexRow = (i64, String, String, String, i64, f64);

/// Candidats par mot-clé (FTS5), les meilleurs BM25 d'abord.
///
/// ATTENTION au SQL : les fonctions auxiliaires FTS5 (`bm25`, `snippet`…)
/// exigent le **nom de la table**, pas un alias — `bm25(f)` sur
/// `FROM chunks_fts f` fait échouer la préparation avec « no such column: f ».
/// C'est exactement ce qui s'était produit : l'erreur était avalée, la moitié
/// lexicale de la recherche hybride était morte sans le dire, et chercher un
/// mot pourtant présent mot pour mot dans un document ne rendait rien.
/// Le test `retrouve_un_mot_present_dans_le_texte` verrouille cette requête.
fn lexical_candidates(conn: &Connection, query: &str, pool: usize) -> Result<Vec<LexRow>, String> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let fts = terms.join(" OR ");
    let mut stmt = conn
        .prepare(
            // `chunks_fts MATCH` (sans nom de colonne) cherche dans le texte ET
            // dans le titre. Le titre pèse plus lourd : nommer un document, c'est
            // le désigner, pas l'évoquer au passage.
            "SELECT c.id, c.text, d.title, c.doc_id, c.ordinal, bm25(chunks_fts, 1.0, 4.0) AS s
             FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.rowid
             JOIN docs d ON d.doc_id = c.doc_id
             WHERE chunks_fts MATCH ?1
             ORDER BY s LIMIT ?2",
        )
        // Plus jamais en silence : une recherche amputée de sa moitié lexicale
        // doit se voir, pas se deviner.
        .map_err(|e| format!("Recherche par mot-clé indisponible : {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![fts, pool as i64], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4).unwrap_or(0),
                r.get::<_, f64>(5).unwrap_or(0.0),
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Recherche **hybride** : deux classements indépendants (mots-clés FTS5/BM25 et
/// similarité vectorielle) fusionnés par RRF.
///
/// L'ancienne version remplissait d'abord `k` extraits lexicaux et ne consultait
/// le vectoriel QUE s'il restait de la place : sur une question formulée avec
/// des mots courants, les meilleurs extraits sémantiques n'étaient jamais
/// atteints — d'où l'impression qu'une partie du document n'était pas indexée.
fn search(
    app: &tauri::AppHandle,
    query: &str,
    k: usize,
    doc_ids: Option<&[String]>,
) -> Result<Vec<Hit>, String> {
    // Filtre appliqué APRÈS la remontée des candidats plutôt qu'en SQL : vec0
    // ne sait pas combiner un MATCH vectoriel avec un WHERE sur une jointure,
    // et la liste de documents d'une discussion est courte.
    let allowed: Option<std::collections::HashSet<&str>> =
        doc_ids.map(|ids| ids.iter().map(String::as_str).collect());
    let keep = |doc_id: &str| allowed.as_ref().map_or(true, |set| set.contains(doc_id));
    let conn = open(app)?;
    let query = query.trim();
    // Indexés par chunk_id pour fusionner les deux classements sans doublon.
    let mut cands: std::collections::HashMap<i64, Cand> = std::collections::HashMap::new();
    // On remonte toujours large : la fusion a besoin de voir les deux listes
    // entières, et le coût est celui d'un SELECT sur une base locale.
    let pool = (k * 8).clamp(k, 80);

    // 1) Lexical (FTS5) — match exact/mots-clés, classement BM25.
    for (rank, row) in lexical_candidates(&conn, query, pool)?.into_iter().enumerate() {
        let (id, text, title, doc_id, ordinal, bm25) = row;
        if !keep(&doc_id) {
            continue;
        }
        cands.insert(
            id,
            Cand {
                hit: Hit {
                    text,
                    title,
                    doc_id,
                    chunk_id: id,
                    ordinal,
                    distance: 1.0,
                    // bm25 de SQLite est négatif (plus petit = meilleur). Repli
                    // seulement : écrasé par la similarité cosinus dès que
                    // l'extrait a un vecteur.
                    score: bm25_score(bm25),
                    lexical: true,
                },
                rank_lex: Some(rank),
                rank_vec: None,
            },
        );
    }

    // 2) Vectoriel — classement sémantique complet, indépendant du lexical.
    let mut qvec: Option<Vec<f32>> = None;
    let cosine = meta_get(&conn, "embed_metric").as_deref() == Some("cosine");
    if meta_get(&conn, "embed_dim").is_some() {
        let emb = resolve_embedder(app, &conn);
        // Une recherche ne doit jamais échouer parce que l'encodeur dort : les
        // résultats lexicaux sont déjà en main, on complète si on peut. En
        // revanche, quand l'encodeur est indisponible ET qu'on n'a RIEN trouvé
        // par mot-clé, renvoyer un succès vide fait croire à l'appelant que le
        // document ne contient pas la réponse : on remonte l'erreur.
        let ready = ensure_embedder_ready(app, &emb);
        if let Err(e) = &ready {
            if cands.is_empty() {
                return Err(format!("Encodeur d'embeddings indisponible : {e}"));
            }
        }
        if ready.is_ok() {
            let v = embed(&emb, query, Role::Query)?;
            let mut stmt = conn
                .prepare(
                    "SELECT c.id, c.text, d.title, c.doc_id, c.ordinal, v.distance
                     FROM vec_chunks v
                     JOIN chunks c ON c.id = v.rowid
                     JOIN docs d ON d.doc_id = c.doc_id
                     WHERE v.embedding MATCH ?1 AND k = ?2
                     ORDER BY v.distance",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![vec_blob(&v), (pool * 2) as i64], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4).unwrap_or(0),
                        r.get::<_, f64>(5)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            let mut rank = 0usize;
            for row in rows {
                let (id, text, title, doc_id, ordinal, distance) = row.map_err(|e| e.to_string())?;
                if !keep(&doc_id) {
                    continue;
                }
                // Aucun filtrage ici : les seuils s'appliquent au moment de
                // choisir quoi renvoyer. Écarter dès la remontée pouvait vider
                // complètement le résultat — une requête d'un seul mot dépasse
                // facilement tous les seuils, et l'utilisateur se retrouvait
                // avec « aucun extrait » sur un document qui contient la
                // réponse.
                let entry = cands.entry(id).or_insert_with(|| Cand {
                    hit: Hit {
                        text,
                        title,
                        doc_id,
                        chunk_id: id,
                        ordinal,
                        distance,
                        score: 0.0,
                        lexical: false,
                    },
                    rank_lex: None,
                    rank_vec: None,
                });
                entry.hit.distance = distance;
                entry.rank_vec = Some(rank);
                if cosine {
                    entry.hit.score = (1.0 - distance).clamp(0.0, 1.0);
                }
                rank += 1;
            }
            qvec = Some(v);
        }
    }

    // Score affichable des extraits purement lexicaux : on relit leur vecteur
    // pour les mettre sur la même échelle que les autres.
    if let Some(q) = qvec.as_ref() {
        for c in cands.values_mut() {
            if c.rank_vec.is_some() {
                continue;
            }
            if let Some(sim) = stored_vector(&conn, c.hit.chunk_id).and_then(|v| cosine_similarity(&v, q)) {
                c.hit.score = sim.clamp(0.0, 1.0);
                c.hit.distance = 1.0 - sim;
            }
        }
    }

    let mut out: Vec<Cand> = cands.into_values().collect();
    // Départage explicite : à score de fusion égal — c'est fréquent, les deux
    // classements produisent les mêmes valeurs RRF — on préfère l'extrait le
    // plus proche sémantiquement, puis le plus ancien. Sans cela l'ordre venait
    // de la table de hachage, donc du hasard.
    out.sort_by(|a, b| {
        b.fused()
            .partial_cmp(&a.fused())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.hit.score.partial_cmp(&a.hit.score).unwrap_or(std::cmp::Ordering::Equal))
            .then(a.hit.chunk_id.cmp(&b.hit.chunk_id))
    });

    // Reranking (cross-encoder, rerank.rs) : relit les meilleurs candidats face
    // à la question et les reclasse. Sans modèle installé, ou en cas d'échec, le
    // classement hybride reste tel quel.
    if out.len() > 1 && crate::rerank::available(app) {
        let top = out.len().min((k * 4).clamp(8, 40));
        let docs: Vec<String> = out[..top].iter().map(|c| format!("{}\n{}", c.hit.title, c.hit.text)).collect();
        match crate::rerank::rerank_blocking(app, query, &docs) {
            Ok(order) if !order.is_empty() => {
                let mut head: Vec<Option<Cand>> = out.drain(..top).map(Some).collect();
                let mut reranked: Vec<Cand> = Vec::with_capacity(top);
                for (i, score) in order {
                    if let Some(mut c) = head.get_mut(i).and_then(Option::take) {
                        c.hit.score = score as f64;
                        reranked.push(c);
                    }
                }
                reranked.extend(head.into_iter().flatten());
                reranked.extend(out);
                return Ok(reranked.into_iter().take(k).map(|c| c.hit).collect());
            }
            Ok(_) => {}
            Err(e) => eprintln!("[rag] reranking ignoré : {e}"),
        }
    }

    Ok(select_hits(out, k, cosine))
}

/// Choisit ce qui est renvoyé, sur une échelle **relative** au meilleur extrait.
///
/// Les seuils absolus ne survivent pas à un changement de modèle : nomic répond
/// autour de 0,6-0,8 de similarité, LFM2.5 autour de 0,2-0,4 sur exactement les
/// mêmes documents. Une barre fixe à 0,60 revenait donc à couper *tout* le
/// vectoriel pour un utilisateur de LFM2.5 — la recherche ne tenait plus que sur
/// les mots-clés. On garde donc ce qui reste dans la bande du meilleur score
/// observé pour CETTE requête, quelle que soit l'échelle du modèle.
fn select_hits(ranked: Vec<Cand>, k: usize, cosine: bool) -> Vec<Hit> {
    /// Part du meilleur score en deçà de laquelle un extrait décroche.
    const RELATIVE_KEEP: f64 = 0.65;
    /// Nombre d'extraits rendus quoi qu'il arrive, tant qu'il existe des
    /// candidats : une liste vide fait croire que le document ne contient pas
    /// la réponse, ce qui est bien pire qu'un extrait moyen affiché avec son score.
    const ALWAYS_KEEP: usize = 3;

    let sim = |c: &Cand| 1.0 - c.hit.distance;
    let best = ranked
        .iter()
        .filter(|c| c.rank_vec.is_some())
        .map(sim)
        .fold(f64::NEG_INFINITY, f64::max);
    let floor = if cosine && best.is_finite() { best * RELATIVE_KEEP } else { f64::NEG_INFINITY };

    // Quota par document, quand le corpus en compte plusieurs. Un document dont
    // tous les extraits contiennent un mot courant de la question raflait sinon
    // les k places, et les autres documents devenaient invisibles — la base
    // entière semblait se résumer à un seul fichier.
    let docs: std::collections::HashSet<&str> =
        ranked.iter().map(|c| c.hit.doc_id.as_str()).collect();
    let per_doc = if docs.len() > 1 { (k.div_ceil(2)).max(2) } else { k };

    let eligible = |i: usize, c: &Cand| {
        // Un match par mot-clé est retenu pour lui-même : il porte les termes
        // exacts de la question, ce qu'aucune similarité ne capture mieux.
        c.rank_lex.is_some() || sim(c) >= floor || i < ALWAYS_KEEP
    };

    let mut out: Vec<Hit> = Vec::new();
    let mut taken: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (i, c) in ranked.iter().enumerate() {
        if out.len() >= k {
            break;
        }
        let n = taken.entry(c.hit.doc_id.as_str()).or_insert(0);
        if *n >= per_doc || !eligible(i, c) {
            continue;
        }
        *n += 1;
        out.push(clone_hit(&c.hit));
    }
    // Second passage sans quota : mieux vaut compléter avec un document déjà
    // bien représenté que rendre moins d'extraits que demandé.
    if out.len() < k {
        for (i, c) in ranked.iter().enumerate() {
            if out.len() >= k {
                break;
            }
            if eligible(i, c) && !out.iter().any(|h| h.chunk_id == c.hit.chunk_id) {
                out.push(clone_hit(&c.hit));
            }
        }
    }
    out
}

fn clone_hit(h: &Hit) -> Hit {
    Hit {
        text: h.text.clone(),
        title: h.title.clone(),
        doc_id: h.doc_id.clone(),
        chunk_id: h.chunk_id,
        ordinal: h.ordinal,
        distance: h.distance,
        score: h.score,
        lexical: h.lexical,
    }
}

/// BM25 (négatif, plus petit = meilleur) → pertinence dans [0..1]. Compression
/// douce : -1 ≈ 0,3 ; -5 ≈ 0,7 ; -12 ≈ 0,85. Ce n'est qu'un repli d'affichage
/// pour les extraits sans vecteur comparable.
fn bm25_score(bm25: f64) -> f64 {
    let s = (-bm25).max(0.0);
    (s / (s + 2.5)).clamp(0.0, 1.0)
}

fn status(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let conn = open(app)?;
    let docs: i64 = conn
        .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))
        .unwrap_or(0);
    let chunks: i64 = conn
        .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
        .unwrap_or(0);
    let metric = meta_get(&conn, "embed_metric");
    let prefixes = meta_get(&conn, "embed_prefix_version");
    Ok(json!({
        "docs": docs,
        "chunks": chunks,
        "embed_model": meta_get(&conn, "embed_model"),
        "embed_dim": meta_get(&conn, "embed_dim").and_then(|s| s.parse::<i64>().ok()),
        "embed_backend": meta_get(&conn, "embed_backend"),
        "embed_metric": metric.clone(),
        "chunk_preset": meta_get(&conn, "chunk_preset").unwrap_or_else(|| "medium".into()),
        // Vrai si des extraits existent mais l'index date d'avant la métrique
        // cosinus OU d'avant les préfixes de tâche du modèle : dans les deux cas
        // les vecteurs stockés ne sont plus comparables à ceux d'une requête
        // encodée aujourd'hui. Le bouton « Réindexer » répare sans ré-import.
        "needs_reindex": chunks > 0
            && (metric.as_deref() != Some("cosine")
                || prefixes.as_deref() != Some(PREFIX_VERSION)),
    }))
}

/// Choix du modèle d'embedding : un GGUF servi par llama.cpp, ou « auto »
/// (déduit de la source d'IA : Ollama ou l'API cloud configurée).
#[tauri::command]
pub fn rag_set_embed_pref(app: tauri::AppHandle, model: String) -> Result<(), String> {
    let m = model.trim();
    let value = if m.is_empty() || m == "auto" {
        "auto".to_string()
    } else {
        if !crate::llama::EMBED_MODELS.contains(&m) {
            return Err(format!("Modèle d'embedding inconnu : {m}"));
        }
        m.to_string()
    };
    let conn = open(&app)?;
    meta_set(&conn, "embed_pref", &value)
}

#[tauri::command]
pub fn rag_get_embed_pref(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let conn = open(&app)?;
    Ok(json!({
        "pref": meta_get(&conn, "embed_pref").unwrap_or_else(|| "auto".into()),
        // Modèle avec lequel l'index EXISTANT a été construit : c'est lui qui
        // dicte s'il faut vider la base avant de changer de choix.
        "indexed_with": meta_get(&conn, "embed_model"),
        "catalog": crate::llama::EMBED_MODELS,
    }))
}

/// Définit le préréglage de découpage (« small » | « medium » | « large »).
/// S'applique aux **prochains** imports (pas de redécoupage rétroactif).
#[tauri::command]
pub fn rag_set_chunk_preset(app: tauri::AppHandle, preset: String) -> Result<(), String> {
    let p = match preset.as_str() {
        "small" | "large" => preset.as_str(),
        _ => "medium",
    };
    let conn = open(&app)?;
    meta_set(&conn, "chunk_preset", p)
}

/// Réindexe toute la base à partir du **texte des chunks déjà stockés** (aucun
/// ré-import nécessaire) : reconstruit la table vectorielle en cosinus avec le
/// modèle d'embedding actif et les préfixes de tâche. À utiliser après une mise à
/// jour du moteur d'embedding ou pour migrer un ancien index L2.
fn reindex(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let conn = open(app)?;
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.text, d.title FROM chunks c
             JOIN docs d ON d.doc_id = c.doc_id ORDER BY c.id",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(i64, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    if rows.is_empty() {
        return Ok(json!({ "reindexed": 0 }));
    }
    // Repart d'une table vectorielle neuve (métrique cosinus) + méta réinitialisée.
    conn.execute_batch(
        "DROP TABLE IF EXISTS vec_chunks;
         DELETE FROM meta WHERE key IN ('embed_dim','embed_model','embed_backend','embed_metric','embed_prefix_version');",
    )
    .map_err(|e| e.to_string())?;
    let emb = resolve_embedder(app, &conn);
    ensure_embedder_ready(app, &emb)?;
    for (i, (id, text, title)) in rows.iter().enumerate() {
        // Même composition qu'à l'ingestion : titre + extrait.
        let vector = embed(&emb, &with_title(title, text), Role::Document)?;
        if i == 0 {
            ensure_vec_table(&conn, vector.len(), &emb.model, &emb.backend)?;
        }
        conn.execute(
            "INSERT INTO vec_chunks(rowid, embedding) VALUES(?1, ?2)",
            rusqlite::params![id, vec_blob(&vector)],
        )
        .map_err(|e| format!("Insertion vectorielle : {e}"))?;
    }
    Ok(json!({ "reindexed": rows.len(), "model": emb.model }))
}

fn list_docs(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let conn = open(app)?;
    let mut stmt = conn
        .prepare(
            "SELECT d.doc_id, d.title, d.source, d.created_at,
                    (SELECT COUNT(*) FROM chunks c WHERE c.doc_id=d.doc_id) AS n,
                    (SELECT COALESCE(SUM(LENGTH(c.text)),0) FROM chunks c WHERE c.doc_id=d.doc_id) AS chars
             FROM docs d ORDER BY d.created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "doc_id": r.get::<_, String>(0)?,
                "title": r.get::<_, String>(1)?,
                "source": r.get::<_, Option<String>>(2)?,
                "created_at": r.get::<_, i64>(3)?,
                "chunks": r.get::<_, i64>(4)?,
                // Volume de texte réellement indexé : un PDF de 40 pages qui ne
                // pèse que 3 000 caractères n'a pas été extrait en entier.
                "chars": r.get::<_, i64>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(serde_json::Value::Array(out))
}

fn delete_doc(app: &tauri::AppHandle, doc_id: &str) -> Result<(), String> {
    let conn = open(app)?;
    conn.execute(
        "DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE doc_id=?1)",
        [doc_id],
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id=?1)",
        [doc_id],
    );
    conn.execute("DELETE FROM chunks WHERE doc_id=?1", [doc_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM docs WHERE doc_id=?1", [doc_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn clear(app: &tauri::AppHandle) -> Result<(), String> {
    let conn = open(app)?;
    // Supprime aussi la table vectorielle pour pouvoir changer de modèle/dimension.
    let _ = conn.execute_batch(
        "DELETE FROM chunks; DELETE FROM docs; DROP TABLE IF EXISTS vec_chunks; DROP TABLE IF EXISTS chunks_fts; DELETE FROM meta;",
    );
    Ok(())
}

// ===== Commandes Tauri (async → spawn_blocking pour ne pas figer le runtime) =====

#[tauri::command]
pub async fn rag_add_text(
    app: tauri::AppHandle,
    title: String,
    text: String,
    source: Option<String>,
) -> Result<serde_json::Value, String> {
    let src = source.unwrap_or_else(|| "texte".into());
    tauri::async_runtime::spawn_blocking(move || ingest_text(&app, &title, &src, &text))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rag_add_file(
    app: tauri::AppHandle,
    path: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let title = p
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("Document")
            .to_string();
        let text = extract_file_text(&p)?;
        ingest_text(&app, &title, &path, &text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ajoute un fichier depuis ses octets (encodés base64), sans avoir besoin d'un
/// chemin disque — pratique pour un `<input type=file>` dans la webview. PDF
/// extrait en mémoire, autres formats traités comme du texte UTF-8.
#[tauri::command]
pub async fn rag_add_file_bytes(
    app: tauri::AppHandle,
    title: String,
    b64: String,
    // Origine du document. La discussion y place `chat:<id>` pour pouvoir
    // retirer ensuite ses documents éphémères sans toucher au Corpus.
    source: Option<String>,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("Base64 invalide : {e}"))?;
    let source = source.unwrap_or_else(|| title.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let text = extract_bytes_text(&title, &bytes)?;
        ingest_text(&app, &title, &source, &text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Extrait le texte d'un document déposé dans la webview, SANS l'indexer.
///
/// C'est ce qui permet à la discussion de trancher : un document court part
/// entier dans le contexte du modèle (fidélité maximale pour un résumé), un
/// document long passe par l'index.
#[tauri::command]
pub async fn doc_extract_text(title: String, b64: String) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("Base64 invalide : {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let text = extract_bytes_text(&title, &bytes)?;
        let chars = text.chars().count();
        Ok(json!({ "text": text, "chars": chars }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rag_search(
    app: tauri::AppHandle,
    query: String,
    k: Option<usize>,
    // Restreint la recherche à ces documents (pièces jointes de la discussion
    // en cours). Absent = toute la base.
    doc_ids: Option<Vec<String>>,
) -> Result<Vec<serde_json::Value>, String> {
    let k = k.unwrap_or(5).clamp(1, 20);
    let hits = tauri::async_runtime::spawn_blocking(move || search(&app, &query, k, doc_ids.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    Ok(hits
        .into_iter()
        .map(|h| json!({
            "text": h.text,
            "title": h.title,
            "doc_id": h.doc_id,
            "chunk_id": h.chunk_id,
            "ordinal": h.ordinal,
            "distance": h.distance,
            "score": h.score,
            "lexical": h.lexical,
        }))
        .collect())
}

#[tauri::command]
pub async fn rag_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || status(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rag_list(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || list_docs(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// Texte d'un document du Corpus, recomposé depuis ses morceaux (Lumen XR
/// l'affiche en panneau de lecture). Borné à `max_chars` (200 000 par défaut).
#[tauri::command]
pub async fn rag_doc_text(
    app: tauri::AppHandle,
    doc_id: String,
    max_chars: Option<usize>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let mut stmt = conn
            .prepare("SELECT text FROM chunks WHERE doc_id=?1 ORDER BY ordinal, id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&doc_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let cap = max_chars.unwrap_or(200_000);
        let mut out = String::new();
        for t in rows.flatten() {
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            out.push_str(&t);
            if out.chars().count() >= cap {
                out = out.chars().take(cap).collect();
                break;
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rag_delete(app: tauri::AppHandle, doc_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_doc(&app, &doc_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rag_clear(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || clear(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rag_reindex(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || reindex(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod embedder_tests {
    use super::*;

    /// Mode « automatique » : llama.cpp local ou Raccourci Apple ne doivent pas
    /// envoyer les embeddings sur l'URL d'Ollama quand un encodeur local existe.
    #[test]
    fn auto_prefere_l_encodeur_local_hors_ollama() {
        let gguf = || Some("LFM2.5-Embedding-350M-Q8_0.gguf".to_string());
        assert_eq!(
            auto_local_embedder("llama", false, None, gguf),
            Some("LFM2.5-Embedding-350M-Q8_0.gguf".to_string())
        );
        assert_eq!(
            auto_local_embedder("shortcut", false, None, gguf),
            Some("LFM2.5-Embedding-350M-Q8_0.gguf".to_string())
        );
        // Ollama et les API gardent le comportement historique.
        assert_eq!(auto_local_embedder("ollama", false, None, gguf), None);
        assert_eq!(auto_local_embedder("api", true, None, gguf), None);
        // Aucun GGUF installé : on retombe sur la source de discussion.
        assert_eq!(auto_local_embedder("llama", false, None, || None), None);
        // Index déjà construit avec un autre encodeur : on n'en change pas.
        assert_eq!(auto_local_embedder("llama", false, Some("nomic-embed-text"), gguf), None);
        assert_eq!(
            auto_local_embedder("llama", false, Some("LFM2.5-Embedding-350M-Q8_0.gguf"), gguf),
            Some("LFM2.5-Embedding-350M-Q8_0.gguf".to_string())
        );
    }
}

#[cfg(test)]
mod pdf_tests {
    use super::*;

    /// Aller-retour sur un PDF produit par Lumen (polices de base PDF) : la
    /// double extraction ne doit pas dégrader le cas nominal, où `pdf-extract`
    /// fait déjà le travail.
    #[test]
    fn extrait_un_pdf_lumen() {
        let pdf = crate::pdf::render_to_pdf("Test", "txt", "Bonjour le monde extractible")
            .expect("rendu PDF");
        let text = extract_pdf_text(&pdf).expect("extraction");
        assert!(text.contains("extractible"), "texte extrait : {text:?}");
    }

    /// Des octets qui ne sont pas un PDF : les deux extracteurs échouent, et
    /// l'erreur doit être explicite plutôt qu'une panique.
    #[test]
    fn refuse_ce_qui_n_est_pas_un_pdf() {
        assert!(extract_pdf_text(b"ceci n'est pas un PDF").is_err());
    }

    /// Le départage se fait sur les LETTRES : c'est ce qui permet de préférer
    /// lopdf quand pdf-extract perd des glyphes (polices Type 1C à encodage
    /// personnalisé), sans se laisser abuser par les espaces.
    #[test]
    fn compte_les_lettres_pas_les_espaces() {
        assert_eq!(letter_count("a b\tc\n"), 3);
        assert_eq!(letter_count("é à ü"), 3);
        assert_eq!(letter_count("123 -- ..."), 0);
    }
}

#[cfg(test)]
mod docx_tests {
    use super::*;
    use std::io::Write as _;

    /// Fabrique un .docx minimal : un ZIP dont `word/document.xml` porte le XML
    /// donné. Suffisant pour l'extracteur, qui n'ouvre que ce fichier.
    fn docx_with(body: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            zip.start_file::<_, ()>("word/document.xml", Default::default())
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        buf
    }

    #[test]
    fn extrait_les_paragraphes_et_les_entites() {
        let xml = r#"<?xml version="1.0"?><w:document><w:body>
            <w:p><w:r><w:t>Premier paragraphe</w:t></w:r></w:p>
            <w:p><w:r><w:t xml:space="preserve">Marie &amp; Cie</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let text = extract_docx_text(&docx_with(xml)).unwrap();
        assert!(text.contains("Premier paragraphe"), "{text}");
        assert!(text.contains("Marie & Cie"), "{text}");
        // Une fin de paragraphe doit couper la ligne, sinon les phrases se
        // collent et le découpage en chunks perd les frontières logiques.
        assert!(text.contains("paragraphe\nMarie"), "{text:?}");
    }

    #[test]
    fn refuse_un_docx_sans_texte() {
        let xml = r#"<w:document><w:body><w:p/></w:body></w:document>"#;
        assert!(extract_docx_text(&docx_with(xml)).is_err());
    }

    #[test]
    fn refuse_un_pdf_sans_couche_texte() {
        // Un PDF scanné ressort quasi vide : mieux vaut le dire que d'indexer
        // un document creux qui semblera consultable.
        assert!(check_pdf_text("  \n \u{c} ".to_string()).is_err());
        assert!(check_pdf_text("Un contenu bien réel et suffisamment long".into()).is_ok());
    }
}

#[cfg(test)]
mod scoring_tests {
    use super::*;

    #[test]
    fn similarite_cosinus() {
        let a = [1.0f32, 0.0, 0.0];
        assert!((cosine_similarity(&a, &[2.0, 0.0, 0.0]).unwrap() - 1.0).abs() < 1e-9);
        assert!(cosine_similarity(&a, &[0.0, 1.0, 0.0]).unwrap().abs() < 1e-9);
        // Dimensions incompatibles ou vecteur nul : pas de score inventé.
        assert!(cosine_similarity(&a, &[1.0, 0.0]).is_none());
        assert!(cosine_similarity(&a, &[0.0, 0.0, 0.0]).is_none());
    }

    /// Le repli BM25 doit rester dans [0..1] et croître avec la qualité du
    /// match (bm25 de SQLite : plus négatif = meilleur).
    #[test]
    fn score_bm25_borne_et_monotone() {
        assert_eq!(bm25_score(0.0), 0.0);
        assert!(bm25_score(-1.0) < bm25_score(-5.0));
        assert!(bm25_score(-50.0) < 1.0);
        // Un bm25 positif (cas dégénéré) ne doit pas produire de score négatif.
        assert_eq!(bm25_score(3.0), 0.0);
    }

    /// Un extrait présent dans les DEUX classements doit passer devant un
    /// extrait mieux classé dans un seul — c'est tout l'intérêt de la fusion.
    #[test]
    fn fusion_rrf_favorise_le_double_signal() {
        let hit = || Hit {
            text: String::new(),
            title: String::new(),
            doc_id: String::new(),
            chunk_id: 0,
            ordinal: 0,
            distance: 0.0,
            score: 0.0,
            lexical: false,
        };
        let deux = Cand { hit: hit(), rank_lex: Some(3), rank_vec: Some(3) };
        let un = Cand { hit: hit(), rank_lex: Some(0), rank_vec: None };
        assert!(deux.fused() > un.fused());
    }
}

#[cfg(test)]
mod lexical_tests {
    use super::*;

    /// Base minimale : docs + chunks + index FTS, sans extension vectorielle
    /// (la moitié lexicale de la recherche doit fonctionner seule).
    fn db_with(chunks: &[&str]) -> Connection {
        let conn = Connection::open_in_memory().expect("sqlite en mémoire");
        conn.execute_batch(
            "CREATE TABLE docs(doc_id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT, created_at INTEGER);
             CREATE TABLE chunks(id INTEGER PRIMARY KEY, doc_id TEXT NOT NULL, ordinal INTEGER, text TEXT NOT NULL);
             CREATE VIRTUAL TABLE chunks_fts USING fts5(text, title);
             INSERT INTO docs VALUES('d1','Manuel LUMIO 30','manuel.pdf',0);",
        )
        .unwrap();
        for (i, text) in chunks.iter().enumerate() {
            conn.execute(
                "INSERT INTO chunks(doc_id,ordinal,text) VALUES('d1',?1,?2)",
                rusqlite::params![i as i64, text],
            )
            .unwrap();
            let rowid = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO chunks_fts(rowid,text,title) VALUES(?1,?2,?3)",
                rusqlite::params![rowid, text, searchable_title("Manuel LUMIO 30")],
            )
            .unwrap();
        }
        conn
    }

    /// LE test de non-régression : la requête a longtemps utilisé `bm25(f)` sur
    /// une table aliasée, ce que FTS5 refuse. L'erreur de préparation était
    /// avalée, donc chercher un mot présent mot pour mot dans un document ne
    /// rendait rien du tout.
    #[test]
    fn retrouve_un_mot_present_dans_le_texte() {
        let conn = db_with(&[
            "Introduction au projet LUMIO 30 et à son architecture.",
            "9. Entretien, démontage et évolutions. 9.1 Entretien courant : dépoussiérer le nid d'abeille.",
            "9.2 Démontage : retirer le nid d'abeille puis la bague et le diffuseur.",
        ]);
        let rows = lexical_candidates(&conn, "démontage", 10).expect("requête lexicale valide");
        assert!(!rows.is_empty(), "aucun extrait pour un mot pourtant indexé");
        // Les extraits de la section 9 doivent primer sur l'introduction.
        assert!(rows.iter().all(|r| r.1.to_lowercase().contains("démontage")));
        assert_eq!(rows[0].2, "Manuel LUMIO 30");
    }

    /// Les termes sont combinés en OR : une question entière doit ramener les
    /// extraits qui n'en portent qu'une partie.
    #[test]
    fn combine_les_termes_en_ou() {
        let conn = db_with(&["Nettoyer les diffuseurs avec un chiffon doux.", "Rien à voir."]);
        let rows = lexical_candidates(&conn, "Comment nettoyer le diffuseur ?", 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].1.starts_with("Nettoyer"));
    }

    /// Une requête sans terme exploitable ne doit pas produire de SQL bancal.
    #[test]
    fn requete_vide_ou_ponctuation() {
        let conn = db_with(&["Un texte quelconque."]);
        assert!(lexical_candidates(&conn, "  ?! -- ", 10).unwrap().is_empty());
    }

    /// Sélection finale : si tout est au-delà des seuils, on rend quand même
    /// les meilleurs candidats plutôt qu'une liste vide.
    #[test]
    fn ne_rend_jamais_vide_quand_il_existe_des_candidats() {
        let cand = |distance: f64, rank_vec: usize| Cand {
            hit: Hit {
                text: String::new(),
                title: String::new(),
                doc_id: String::new(),
                chunk_id: rank_vec as i64,
                ordinal: 0,
                distance,
                score: 1.0 - distance,
                lexical: false,
            },
            rank_lex: None,
            rank_vec: Some(rank_vec),
        };
        // Similarités toutes faibles (échelle d'un modèle comme LFM2.5) : on
        // rend quand même, en gardant la bande du meilleur (0,20 → seuil 0,13).
        let lointains = vec![cand(0.80, 0), cand(0.85, 1), cand(0.90, 2), cand(0.95, 3)];
        let out = select_hits(lointains, 8, true);
        assert!(!out.is_empty(), "jamais vide quand des candidats existent");
        assert!(out.len() >= 3, "au moins les 3 meilleurs");
        // Un extrait nettement meilleur relègue les autres hors de la bande.
        let mixte = vec![cand(0.30, 0), cand(0.99, 1), cand(0.99, 2), cand(0.99, 3), cand(0.99, 4)];
        let out = select_hits(mixte, 8, true);
        assert_eq!(out.len(), 3, "le plancher ALWAYS_KEEP, pas un de plus");
        assert!((out[0].distance - 0.30).abs() < 1e-9);
    }
}

#[cfg(test)]
mod stored_vector_tests {
    use super::*;

    /// Relecture d'un vecteur depuis `vec_chunks` : c'est ce qui donne un score
    /// cosinus aux extraits trouvés par mot-clé. Si ce point d'accès ne marche
    /// pas, ils retombent tous sur le repli BM25 — des pourcentages bas et sur
    /// une échelle différente de celle des extraits vectoriels.
    #[test]
    fn relit_le_vecteur_d_un_extrait() {
        ensure_vec_ext();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[4] distance_metric=cosine);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vec_chunks(rowid, embedding) VALUES(7, ?1)",
            rusqlite::params![vec_blob(&[0.5f32, -0.25, 0.75, 1.0])],
        )
        .unwrap();
        let v = stored_vector(&conn, 7).expect("vecteur relu");
        assert_eq!(v, vec![0.5f32, -0.25, 0.75, 1.0]);
        assert!(stored_vector(&conn, 999).is_none());
    }
}

#[cfg(test)]
mod prefix_tests {
    use super::*;

    /// Chaque famille de modèles a son protocole. Se tromper ne lève aucune
    /// erreur : la recherche devient juste médiocre, donc c'est testé.
    #[test]
    fn prefixes_par_famille_de_modele() {
        assert_eq!(task_prefix("nomic-embed-text", Role::Query), "search_query: ");
        assert_eq!(task_prefix("nomic-embed-text", Role::Document), "search_document: ");
        assert_eq!(task_prefix("LFM2.5-Embedding-350M-Q8_0.gguf", Role::Query), "query: ");
        assert_eq!(task_prefix("embeddinggemma-300M-Q8_0.gguf", Role::Query), "task: search result | query: ");
        assert_eq!(task_prefix("embeddinggemma-300M-Q8_0.gguf", Role::Document), "title: none | text: ");
        assert_eq!(task_prefix("LFM2.5-Embedding-350M-Q8_0.gguf", Role::Document), "document: ");
        assert!(task_prefix("Qwen3-Embedding-0.6B-Q8_0.gguf", Role::Query).starts_with("Instruct:"));
        assert_eq!(task_prefix("Qwen3-Embedding-0.6B-Q8_0.gguf", Role::Document), "");
        // Modèle inconnu (API cloud) : aucun préfixe inventé.
        assert_eq!(task_prefix("text-embedding-3-small", Role::Query), "");
    }
}

#[cfg(test)]
mod multi_doc_tests {
    use super::*;

    /// Deux documents, comme une vraie base. Le titre est indexé à part du
    /// texte, exactement comme à l'ingestion.
    fn db_two_docs() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE docs(doc_id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT, created_at INTEGER);
             CREATE TABLE chunks(id INTEGER PRIMARY KEY, doc_id TEXT NOT NULL, ordinal INTEGER, text TEXT NOT NULL);
             CREATE VIRTUAL TABLE chunks_fts USING fts5(text, title);
             INSERT INTO docs VALUES('d1','LUMIO30_V2_Manuel_Projet_et_Montage.pdf','a.pdf',0);
             INSERT INTO docs VALUES('d2','RESTAPIforBlackmagicCameras.pdf','b.pdf',0);",
        )
        .unwrap();
        let add = |doc: &str, title: &str, ord: i64, text: &str| {
            conn.execute(
                "INSERT INTO chunks(doc_id,ordinal,text) VALUES(?1,?2,?3)",
                rusqlite::params![doc, ord, text],
            )
            .unwrap();
            let rowid = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO chunks_fts(rowid,text,title) VALUES(?1,?2,?3)",
                rusqlite::params![rowid, text, searchable_title(title)],
            )
            .unwrap();
        };
        let t1 = "LUMIO30_V2_Manuel_Projet_et_Montage.pdf";
        let t2 = "RESTAPIforBlackmagicCameras.pdf";
        // Le document 1 contient les mots vides de la question — c'est ce qui
        // lui faisait rafler toutes les places.
        add("d1", t1, 0, "Ce manuel de projet décrit ce dont on parle : la softbox et son montage.");
        add("d1", t1, 1, "De quoi parle ce chapitre : des vis, de la douille et du diffuseur.");
        add("d2", t2, 0, "The response is JSON. Every endpoint of the camera control API returns a payload.");
        add("d2", t2, 1, "Transport control: play, record and timecode endpoints.");
        conn
    }

    /// LE cas signalé : une question qui NOMME un document. Le nom du fichier
    /// n'apparaît nulle part dans le corps du texte — sans titre indexé, la
    /// recherche ne pouvait remonter que l'autre document, et la base semblait
    /// se limiter à un seul fichier.
    #[test]
    fn retrouve_un_document_par_son_nom() {
        let conn = db_two_docs();
        let rows = lexical_candidates(&conn, "De quoi parle RESTAPIforBlackmagicCameras.pdf ?", 10).unwrap();
        assert!(!rows.is_empty(), "aucun extrait pour un document nommé dans la question");
        assert_eq!(rows[0].3, "d2", "le document nommé doit arriver en tête");
    }

    /// Le nom du fichier est aussi cherchable par ses mots : personne n'écrit
    /// « RESTAPIforBlackmagicCameras » en entier.
    #[test]
    fn retrouve_un_document_par_un_mot_de_son_titre() {
        let conn = db_two_docs();
        let rows = lexical_candidates(&conn, "blackmagic", 10).unwrap();
        assert!(rows.iter().all(|r| r.3 == "d2"));
        assert!(!rows.is_empty());
    }

    /// Les mots vides ne doivent plus ramener un document entier.
    #[test]
    fn les_mots_vides_ne_ramenent_pas_tout() {
        let conn = db_two_docs();
        let rows = lexical_candidates(&conn, "de quoi parle ce document ?", 10).unwrap();
        // « de », « quoi », « parle », « ce » sont écartés ; il ne reste
        // « document », qui n'est dans aucun extrait.
        assert!(rows.is_empty(), "les mots vides ont ramené : {rows:?}");
        // Mais une question qui n'est FAITE que de mots vides cherche quand même.
        assert!(!lexical_candidates(&conn, "de quoi parle", 10).unwrap().is_empty());
    }

    /// Un document ne peut pas monopoliser tous les extraits rendus quand
    /// plusieurs documents répondent.
    #[test]
    fn le_quota_par_document_laisse_de_la_place_aux_autres() {
        let cand = |doc: &str, id: i64, rank: usize| Cand {
            hit: Hit {
                text: String::new(),
                title: String::new(),
                doc_id: doc.to_string(),
                chunk_id: id,
                ordinal: 0,
                distance: 0.2,
                score: 0.8,
                lexical: true,
            },
            rank_lex: Some(rank),
            rank_vec: None,
        };
        // Six candidats du même document, puis deux d'un autre.
        let mut ranked: Vec<Cand> = (0..6).map(|i| cand("d1", i, i as usize)).collect();
        ranked.push(cand("d2", 100, 6));
        ranked.push(cand("d2", 101, 7));
        let out = select_hits(ranked, 6, true);
        assert_eq!(out.len(), 6);
        let d2 = out.iter().filter(|h| h.doc_id == "d2").count();
        assert!(d2 >= 2, "le second document doit apparaître, obtenu {d2}");
    }

    /// Expansion des titres : le nom d'origine ET ses mots.
    #[test]
    fn titre_cherchable() {
        let t = searchable_title("RESTAPIforBlackmagicCameras.pdf");
        assert!(t.contains("RESTAPIforBlackmagicCameras.pdf"), "{t}");
        for mot in ["API", "for", "Blackmagic", "Cameras", "pdf"] {
            assert!(t.contains(mot), "« {mot} » absent de {t:?}");
        }
        let t2 = searchable_title("LUMIO30_V2_Manuel_Projet_et_Montage.pdf");
        assert!(t2.contains("Manuel"), "{t2}");
        assert!(t2.contains("Montage"), "{t2}");
    }
}

#[cfg(test)]
mod vector_blob_tests {
    use super::*;

    /// Aller-retour binaire : ce que l'on écrit est ce que `stored_vector`
    /// relit.
    #[test]
    fn aller_retour_du_blob() {
        let v = [0.5f32, -0.25, 1e-8, 12345.6];
        let blob = vec_blob(&v);
        assert_eq!(blob.len(), v.len() * 4);
        let relu: Vec<f32> = blob
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        assert_eq!(relu, v.to_vec());
    }

    /// Les valeurs non finies ne descendent jamais dans la base.
    #[test]
    fn neutralise_les_valeurs_non_finies() {
        let blob = vec_blob(&[f32::NAN, f32::INFINITY, 0.5]);
        let relu: Vec<f32> = blob
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        assert_eq!(relu, vec![0.0, 0.0, 0.5]);
    }

    /// LE test de non-régression Linux : sous une locale à virgule décimale —
    /// celle que GTK impose au processus au démarrage — l'insertion doit
    /// passer. Avec du texte JSON, sqlite-vec échouait ici sur « JSON parsing
    /// error », et seul Linux était touché.
    ///
    /// `setlocale` agit sur TOUT le processus : la locale est rétablie
    /// immédiatement après l'insertion, sans quoi les tests exécutés en
    /// parallèle en hériteraient.
    #[test]
    fn insertion_sous_locale_a_virgule() {
        extern "C" {
            fn setlocale(category: i32, locale: *const std::os::raw::c_char) -> *mut std::os::raw::c_char;
        }
        // LC_NUMERIC : 1 sur Linux, 4 sur macOS. On pose les deux, le
        // catégorie inexistante étant sans effet.
        const LC_NUMERIC_CANDIDATES: [i32; 2] = [1, 4];

        ensure_vec_ext();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE v USING vec0(embedding float[4] distance_metric=cosine);",
        )
        .unwrap();
        let blob = vec_blob(&[0.5, -0.25, 0.75, 1.0]);

        let fr = std::ffi::CString::new("fr_FR.UTF-8").unwrap();
        let c = std::ffi::CString::new("C").unwrap();
        let mut applied = false;
        unsafe {
            for cat in LC_NUMERIC_CANDIDATES {
                if !setlocale(cat, fr.as_ptr()).is_null() {
                    applied = true;
                }
            }
        }
        let res = conn.execute(
            "INSERT INTO v(rowid, embedding) VALUES(1, ?1)",
            rusqlite::params![blob],
        );
        unsafe {
            for cat in LC_NUMERIC_CANDIDATES {
                setlocale(cat, c.as_ptr());
            }
        }
        // Machine sans locale française installée : le test n'a rien pu
        // éprouver, on ne le fait pas échouer pour autant.
        if !applied {
            eprintln!("locale fr_FR absente : vérification ignorée");
            return;
        }
        assert!(res.is_ok(), "insertion refusée sous locale à virgule : {res:?}");
    }

    /// La RECHERCHE aussi passe un vecteur : si vec0 n'acceptait le binaire
    /// qu'à l'insertion, le correctif aurait réparé l'indexation et cassé
    /// l'interrogation — sous locale à virgule, personne ne l'aurait vu venir.
    #[test]
    fn recherche_knn_avec_un_blob() {
        ensure_vec_ext();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE v USING vec0(embedding float[3] distance_metric=cosine);",
        )
        .unwrap();
        for (rowid, vector) in [(1i64, [1.0f32, 0.0, 0.0]), (2, [0.0, 1.0, 0.0]), (3, [0.9, 0.1, 0.0])] {
            conn.execute(
                "INSERT INTO v(rowid, embedding) VALUES(?1, ?2)",
                rusqlite::params![rowid, vec_blob(&vector)],
            )
            .unwrap();
        }
        let mut stmt = conn
            .prepare("SELECT rowid, distance FROM v WHERE embedding MATCH ?1 AND k = ?2 ORDER BY distance")
            .unwrap();
        let hits: Vec<(i64, f64)> = stmt
            .query_map(rusqlite::params![vec_blob(&[1.0f32, 0.0, 0.0]), 3i64], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].0, 1, "le vecteur identique doit sortir premier");
        assert!(hits[0].1 < hits[1].1 && hits[1].1 < hits[2].1, "distances : {hits:?}");
        assert_eq!(hits[1].0, 3, "puis le plus proche");
    }

    /// Un encodeur qui déraille doit être nommé, pas laissé à sqlite-vec.
    #[test]
    fn refuse_un_vecteur_non_fini() {
        // 1e300 est un nombre JSON parfaitement légal, et tient dans un f64 —
        // mais pas dans un f32 : la conversion sature à +infini.
        let v: serde_json::Value = serde_json::from_str("[0.1, 1e300, 0.3]").unwrap();
        let err = extract_vec(&v).unwrap_err();
        assert!(err.contains("non finies"), "message : {err}");
        assert!(extract_vec(&serde_json::json!([0.1, 0.2])).is_ok());
    }

    /// Réponse « un vecteur par jeton » (pooling absent) : erreur explicite
    /// plutôt qu'un index aux dimensions incohérentes.
    #[test]
    fn refuse_une_reponse_par_jeton() {
        let v = serde_json::json!([[0.1, 0.2], [0.3, 0.4]]);
        let err = extract_vec(&v).unwrap_err();
        assert!(err.contains("pooling"), "message : {err}");
    }

    #[test]
    fn refuse_un_vecteur_vide() {
        assert!(extract_vec(&serde_json::json!([])).is_err());
        assert!(extract_vec(&serde_json::json!("pas un tableau")).is_err());
    }
}


#[cfg(test)]
mod doc_extraction_tests {
    use super::*;

    fn zip_with(entries: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write as _;
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            for (name, body) in entries {
                zip.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        buf
    }

    #[test]
    fn lit_le_texte_des_cellules_d_un_xlsx() {
        let bytes = zip_with(&[(
            "xl/sharedStrings.xml",
            "<sst><si><t>Camille</t></si><si><t>Développeur</t></si></sst>",
        )]);
        let text = extract_document_text("classeur.xlsx", &bytes).unwrap();
        assert!(text.contains("Camille"));
        assert!(text.contains("Développeur"));
    }

    #[test]
    fn lit_les_diapositives_dans_l_ordre() {
        let bytes = zip_with(&[
            ("ppt/slides/slide2.xml", "<p><a:t>seconde</a:t></p>"),
            ("ppt/slides/slide1.xml", "<p><a:t>première</a:t></p>"),
        ]);
        let text = extract_document_text("deck.pptx", &bytes).unwrap();
        assert!(text.find("première").unwrap() < text.find("seconde").unwrap());
    }

    #[test]
    fn ecarte_scripts_et_styles_d_une_page_html() {
        let html = "<html><style>p{color:red}</style><body><p>Bonjour</p><script>var x=1</script><p>Monde</p></body></html>";
        let text = extract_document_text("page.html", html.as_bytes()).unwrap();
        assert!(text.contains("Bonjour") && text.contains("Monde"));
        assert!(!text.contains("color") && !text.contains("var x"));
    }

    #[test]
    fn refuse_un_binaire_sans_extension_connue() {
        assert!(extract_document_text("blob.bin", &[0u8, 159, 146, 150]).is_err());
    }
}

#[cfg(test)]
mod local_pdf_probe {
    /// Sonde manuelle : LUMEN_PDF_PROBE=<chemin> cargo test --lib local_pdf_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn probe() {
        let Ok(path) = std::env::var("LUMEN_PDF_PROBE") else { return };
        let bytes = std::fs::read(&path).unwrap();
        match super::extract_document_text(&path, &bytes) {
            Ok(t) => println!("OK : {} caractères, {} lettres, {} lignes", t.chars().count(), t.chars().filter(|c| c.is_alphabetic()).count(), t.lines().count()),
            Err(e) => println!("ERREUR : {e}"),
        }
    }
}

// ===================== Encodeur pour le coffre unifié (datahub.rs) =====================

/// Encodeur des fiches du coffre unifié : le même que le Corpus, mais LOCAL
/// uniquement (GGUF servi par llama-server, ou Ollama). Le coffre contient
/// tout — notes, courriels, documents : il ne part jamais vers une API cloud
/// pour être encodé. Sans encodeur local, le coffre reste en plein texte seul.
pub struct HubEmbedder(Embedder);

impl HubEmbedder {
    pub fn model(&self) -> &str {
        &self.0.model
    }
    /// Vecteur d'un passage (`query` = question de l'utilisateur). Bloquant.
    pub fn embed(&self, text: &str, query: bool) -> Result<Vec<f32>, String> {
        embed(&self.0, text, if query { Role::Query } else { Role::Document })
    }
}

/// Encodeur local disponible et démarré, sinon None. Bloquant (démarrage du
/// serveur d'embeddings) : jamais depuis un contexte async.
pub fn hub_embedder(app: &tauri::AppHandle) -> Option<HubEmbedder> {
    let conn = open(app).ok()?;
    let emb = resolve_embedder(app, &conn);
    if emb.backend == "openai" {
        return None;
    }
    ensure_embedder_ready(app, &emb).ok()?;
    Some(HubEmbedder(emb))
}

/// Similarité cosinus (0 si dimensions incompatibles).
pub fn cosine(a: &[f32], b: &[f32]) -> f64 {
    cosine_similarity(a, b).unwrap_or(0.0)
}
