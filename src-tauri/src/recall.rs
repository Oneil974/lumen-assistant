// ===== RecallStore : mémoire cognitive multi-types, cloisonnée et locale =====
//
// Couche « souvenirs » de Lumen, posée AU-DESSUS du `MemoryStore` clé/valeur
// (cf. `memory.rs`, qui reste la mémoire « partagée » opérationnelle des
// raccourcis et du heartbeat). Quatre types, ceux des architectures d'agents
// actuelles (Session / Semantic / Procedural / Episodic) :
//
//   session    — mémoire de travail de la conversation en cours : contexte,
//                décisions, préférences du moment. Courte (24 h par défaut).
//   semantic   — faits stables : sur l'utilisateur (préférences, goûts, ton),
//                ses proches, ses projets, le monde.
//   procedural — comment un travail se fait : méthodes, recettes, routines et
//                habitudes, étapes qui ont réussi (agents, workflows).
//   episodic   — ce qui s'est passé (et ce qui est prévu) : événements datés,
//                échanges marquants, résultats de tâches.
//
// Les 8 anciens types (émotionnel, prospectif, comportemental, narratif,
// partagé) sont REPLIÉS sur ces quatre à l'ouverture (cf. `legacy_kind`) ;
// l'API accepte encore leurs noms pour les appelants pas encore mis à jour.
//
// PRINCIPES DE SÉCURITÉ (le cœur de la demande utilisateur) :
//   • CLOISONNEMENT PAR POLITIQUE. Chaque appelant porte un `context` (id d'app,
//     d'agent, ou « barre »). Une `Policy` décide, par (context, type), un accès
//     `none | read | write`. L'enforcement est CÔTÉ RUST, au passage des
//     commandes — un bloc Fluxo ou un agent compromis (prompt-injection) ne peut
//     pas lire un type qu'on ne lui a pas ouvert. cf. sandbox-subsystem.
//   • OPTIONNELLE et NON-CASSANTE, comme `memory.rs` : fichiers séparés sous
//     `app_data_dir/recall/`. Absents/corrompus ⇒ Lumen démarre normalement.
//   • À PLAT et HORS-LIGNE. Le rappel est lexical + récence + saillance : aucun
//     appel réseau requis, fonctionne sans Ollama. (Les embeddings vectoriels
//     pourront enrichir le score plus tard sans changer l'API.)
//   • ÉCRITURE ATOMIQUE (tmp + rename) et PERMISSIONS RESTREINTES (0600 sous
//     Unix) : les types émotionnel / narratif sont intimes.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Les 4 types de mémoire. Sérialisés en chaînes stables (clés de fichiers et
/// d'API). `KINDS` sert aux listings et au cloisonnement.
pub const KINDS: [&str; 4] = ["session", "semantic", "procedural", "episodic"];

/// Repli des anciens types sur les quatre actuels.
///   émotionnel (goûts, ton) → sémantique ; narratif (récit consolidé) → sémantique ;
///   partagé → sémantique ; comportemental (habitudes) → procédural ;
///   prospectif (intentions, rappels) → épisodique.
pub fn legacy_kind(kind: &str) -> &str {
    match kind {
        "emotional" | "narrative" | "shared" => "semantic",
        "behavioral" => "procedural",
        "prospective" => "episodic",
        "working" | "short_term" => "session",
        other => other,
    }
}
const LEGACY: [&str; 5] = ["emotional", "narrative", "shared", "behavioral", "prospective"];

/// Durée de vie par défaut d'un souvenir de session.
const SESSION_TTL_MS: u64 = 24 * 3600 * 1000;

/// Demi-vie de récence (en jours) par type : un épisode vieillit vite, un fait
/// sémantique très lentement. Pilote la décroissance du score de récence.
fn half_life_days(kind: &str) -> f64 {
    match kind {
        "session" => 1.0,
        "episodic" => 14.0,
        "procedural" => 180.0,
        "semantic" => 365.0,
        _ => 60.0,
    }
}

/// Plafond d'items par type (borne la taille des fichiers ; au-delà, on élague
/// les items non épinglés au plus faible score composite).
const MAX_ITEMS_PER_KIND: usize = 2000;

/// Contextes « gestionnaires » : seuls eux peuvent éditer/oublier/purger et
/// modifier la politique. L'app Mémoire et les Réglages s'identifient ainsi.
const MANAGER_CONTEXTS: [&str; 3] = ["app:memory", "settings", "system"];

fn is_manager(context: &str) -> bool {
    MANAGER_CONTEXTS.contains(&context)
}

/// Un souvenir.
#[derive(Clone, Serialize, Deserialize)]
pub struct MemoryItem {
    pub id: String,
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Origine (app/agent qui a écrit), pour la traçabilité.
    #[serde(default)]
    pub source: String,
    /// Importance subjective [0..1]. Pondère le rappel ; renforcée à l'accès.
    #[serde(default = "default_salience")]
    pub salience: f32,
    /// Épinglé : jamais élagué automatiquement.
    #[serde(default)]
    pub pinned: bool,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub last_access: u64,
    #[serde(default)]
    pub access_count: u64,
    /// Expiration optionnelle (epoch ms) — surtout pour le prospectif.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    /// Données structurées libres (provenance, liens, etc.).
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub meta: Value,
}

fn default_salience() -> f32 {
    0.5
}

impl MemoryItem {
    fn is_expired(&self, now: u64) -> bool {
        self.expires_at.map(|e| e <= now).unwrap_or(false)
    }
}

/// Un item + son score de rappel, renvoyé par `recall`.
#[derive(Clone, Serialize)]
pub struct ScoredItem {
    #[serde(flatten)]
    pub item: MemoryItem,
    pub score: f32,
}

// ---------------------------------------------------------------------------
// Politique d'accès
// ---------------------------------------------------------------------------

/// Politique : `context -> (kind -> "none"|"read"|"write")`. Stockée en JSON
/// pour rester éditable depuis l'app Mémoire et lisible à l'œil nu.
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Policy {
    #[serde(default)]
    pub table: BTreeMap<String, BTreeMap<String, String>>,
}

/// Politique par défaut : principe du moindre privilège. Tout contexte non listé
/// n'a accès à rien (sauf gestionnaires, traités à part). « write » implique
/// « read ».
fn default_policy() -> Policy {
    // (context, [(kind, access)])
    let rows: &[(&str, &[(&str, &str)])] = &[
        // Discussion (barre, mode application, bureau) : tout lire, retenir
        // la session et les événements ; les faits passent par l'utilisateur
        // (« retiens que… ») ou la consolidation.
        ("bar", &[("session", "write"), ("semantic", "write"), ("procedural", "read"), ("episodic", "write")]),
        // Agents : apprennent des façons de faire et consignent ce qu'ils font.
        ("agent", &[("session", "write"), ("semantic", "read"), ("procedural", "write"), ("episodic", "write")]),
        // Messages, passerelles : comme la discussion.
        ("messenger", &[("session", "write"), ("semantic", "read"), ("procedural", "read"), ("episodic", "write")]),
        ("telegram", &[("session", "write"), ("semantic", "read"), ("procedural", "read"), ("episodic", "write")]),
        // Apps qui en tirent parti.
        ("domotique", &[("semantic", "read"), ("procedural", "write"), ("episodic", "write")]),
        ("studio", &[("semantic", "write")]),
        ("moodboard", &[("semantic", "write")]),
        ("notes", &[("semantic", "write"), ("episodic", "read")]),
        ("mindmap", &[("semantic", "write"), ("episodic", "read")]),
        ("studies", &[("semantic", "write"), ("procedural", "write"), ("episodic", "write")]),
        ("calendar", &[("semantic", "read"), ("episodic", "write")]),
        ("mail", &[("semantic", "read"), ("episodic", "write")]),
        ("fluxo", &[("semantic", "read"), ("procedural", "write"), ("episodic", "write")]),
        (
            "consolidation",
            &[("session", "read"), ("episodic", "read"), ("semantic", "write"), ("procedural", "write")],
        ),
    ];
    let mut table = BTreeMap::new();
    for (ctx, kinds) in rows {
        let mut m = BTreeMap::new();
        for (k, a) in *kinds {
            m.insert((*k).to_string(), (*a).to_string());
        }
        table.insert((*ctx).to_string(), m);
    }
    Policy { table }
}

impl Policy {
    fn access(&self, context: &str, kind: &str) -> &str {
        self.table
            .get(context)
            .and_then(|m| m.get(kind))
            .map(|s| s.as_str())
            .unwrap_or("none")
    }
    fn can_read(&self, context: &str, kind: &str) -> bool {
        if is_manager(context) {
            return true;
        }
        matches!(self.access(context, kind), "read" | "write")
    }
    fn can_write(&self, context: &str, kind: &str) -> bool {
        if is_manager(context) {
            return true;
        }
        self.access(context, kind) == "write"
    }
}

// ---------------------------------------------------------------------------
// Le store
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct RecallStore {
    app: Arc<Mutex<Option<tauri::AppHandle>>>,
    dir: Arc<Mutex<Option<PathBuf>>>,
    policy: Arc<Mutex<Policy>>,
}

fn valid_kind(kind: &str) -> bool {
    KINDS.contains(&legacy_kind(kind))
}

/// Écrit un fichier de façon atomique et, sous Unix, en 0600 (lecture/écriture
/// propriétaire uniquement — ces données peuvent être intimes).
fn secure_write(path: &PathBuf, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path)
}

impl RecallStore {
    pub async fn init(&self, app: &tauri::AppHandle) {
        *self.app.lock().await = Some(app.clone());
        let dir = crate::paths::shared_data_dir(app.path()).ok().map(|d| d.join("recall"));
        if let Some(ref d) = dir {
            let _ = std::fs::create_dir_all(d);
        }
        *self.dir.lock().await = dir;

        // Charge la politique (ou installe la politique par défaut).
        let loaded = self
            .policy_path()
            .await
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Policy>(&s).ok());
        let mut pol = loaded.unwrap_or_else(default_policy);
        // Politique d'avant la réduction à 4 types : les droits des anciens
        // types sont reportés sur leur type d'accueil (le plus large l'emporte).
        let rank = |a: &str| match a { "write" => 2, "read" => 1, _ => 0 };
        let mut migrated = false;
        for row in pol.table.values_mut() {
            for old in LEGACY {
                if let Some(acc) = row.remove(old) {
                    migrated = true;
                    let tgt = legacy_kind(old).to_string();
                    let cur = row.get(&tgt).cloned().unwrap_or_else(|| "none".into());
                    if rank(&acc) > rank(&cur) { row.insert(tgt, acc); }
                }
            }
        }
        // Contextes ajoutés depuis (messenger, studies…) : repris du défaut.
        for (ctx, row) in default_policy().table {
            if !pol.table.contains_key(&ctx) { pol.table.insert(ctx, row); migrated = true; }
        }
        *self.policy.lock().await = pol;
        if migrated { self.persist_policy().await; }
        self.migrate_legacy_files().await;
    }

    /// Replie les fichiers des anciens types sur les quatre actuels (une fois).
    async fn migrate_legacy_files(&self) {
        let Some(dir) = self.dir().await else { return };
        for old in LEGACY {
            let path = dir.join(format!("{old}.json"));
            if !path.exists() { continue; }
            let moved = Self::read_kind_file(&path);
            let target = legacy_kind(old);
            let mut items = self.load(target).await;
            for mut it in moved {
                if !it.tags.iter().any(|t| t == old) { it.tags.push(old.to_string()); }
                it.kind = target.to_string();
                items.push(it);
            }
            items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            self.save(target, items).await;
            let _ = std::fs::rename(&path, dir.join(format!("{old}.json.migrated")));
        }
    }

    async fn dir(&self) -> Option<PathBuf> {
        self.dir.lock().await.clone()
    }

    async fn kind_path(&self, kind: &str) -> Option<PathBuf> {
        self.dir().await.map(|d| d.join(format!("{kind}.json")))
    }

    async fn policy_path(&self) -> Option<PathBuf> {
        self.dir().await.map(|d| d.join("policy.json"))
    }

    fn read_kind_file(path: &PathBuf) -> Vec<MemoryItem> {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<MemoryItem>>(&s).ok())
            .unwrap_or_default()
    }

    async fn load(&self, kind: &str) -> Vec<MemoryItem> {
        match self.kind_path(kind).await {
            Some(p) => Self::read_kind_file(&p),
            None => Vec::new(),
        }
    }

    /// Persiste un type (élagage des expirés + borne de taille) et notifie l'UI.
    async fn save(&self, kind: &str, mut items: Vec<MemoryItem>) {
        let now = now_ms();
        items.retain(|i| !i.is_expired(now));
        if items.len() > MAX_ITEMS_PER_KIND {
            // Élague les non épinglés au plus faible score composite.
            items.sort_by(|a, b| {
                composite(b, now)
                    .partial_cmp(&composite(a, now))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let mut kept: Vec<MemoryItem> = Vec::with_capacity(MAX_ITEMS_PER_KIND);
            let mut overflow: Vec<MemoryItem> = Vec::new();
            for it in items {
                if it.pinned || kept.len() < MAX_ITEMS_PER_KIND {
                    kept.push(it);
                } else {
                    overflow.push(it);
                }
            }
            let _ = overflow;
            items = kept;
        }
        if let Some(p) = self.kind_path(kind).await {
            if let Ok(txt) = serde_json::to_string_pretty(&items) {
                let _ = secure_write(&p, txt.as_bytes());
            }
        }
        self.notify(kind, "save").await;
    }

    async fn notify(&self, kind: &str, action: &str) {
        if let Some(app) = self.app.lock().await.as_ref() {
            let _ = app.emit("recall-changed", json!({ "kind": kind, "action": action }));
        }
    }

    pub async fn policy(&self) -> Policy {
        self.policy.lock().await.clone()
    }

    async fn persist_policy(&self) {
        let pol = self.policy.lock().await.clone();
        if let Some(p) = self.policy_path().await {
            if let Ok(txt) = serde_json::to_string_pretty(&pol) {
                let _ = secure_write(&p, txt.as_bytes());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Scoring du rappel
// ---------------------------------------------------------------------------

fn tokenize(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|w| w.len() > 1)
        .map(|w| w.to_string())
        .collect()
}

/// Pertinence lexicale [0..1] : recouvrement des tokens de la requête présents
/// dans l'item (rappel orienté requête). Requête vide ⇒ 0.
fn lexical(query_tokens: &[String], item: &MemoryItem) -> f32 {
    if query_tokens.is_empty() {
        return 0.0;
    }
    let hay = tokenize(&format!("{} {}", item.text, item.tags.join(" ")));
    if hay.is_empty() {
        return 0.0;
    }
    let hits = query_tokens.iter().filter(|q| hay.contains(q)).count();
    hits as f32 / query_tokens.len() as f32
}

fn recency(item: &MemoryItem, now: u64) -> f32 {
    let age_days = (now.saturating_sub(item.updated_at) as f64) / 86_400_000.0;
    let hl = half_life_days(&item.kind);
    (1.0 / (1.0 + age_days / hl)) as f32
}

/// Score composite indépendant de la requête (récence + saillance + accès) —
/// sert au tri par défaut et à l'élagage.
fn composite(item: &MemoryItem, now: u64) -> f32 {
    let access = (item.access_count as f32).ln_1p() / 5.0;
    let pin = if item.pinned { 0.25 } else { 0.0 };
    0.5 * recency(item, now) + 0.35 * item.salience.clamp(0.0, 1.0) + 0.15 * access.min(1.0) + pin
}

fn relevance(query_tokens: &[String], item: &MemoryItem, now: u64) -> f32 {
    let lex = lexical(query_tokens, item);
    // Si requête présente, la pertinence lexicale domine ; sinon, composite seul.
    if query_tokens.is_empty() {
        composite(item, now)
    } else {
        0.6 * lex + 0.4 * composite(item, now)
    }
}

// ---------------------------------------------------------------------------
// Commandes Tauri
// ---------------------------------------------------------------------------

/// Enregistre un souvenir. Refusé si la politique n'autorise pas l'écriture du
/// `kind` pour ce `context`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mem_remember(
    store: tauri::State<'_, RecallStore>,
    context: String,
    kind: String,
    text: String,
    tags: Option<Vec<String>>,
    salience: Option<f32>,
    source: Option<String>,
    ttl_ms: Option<u64>,
    meta: Option<Value>,
) -> Result<MemoryItem, String> {
    let kind = legacy_kind(&kind).to_string();
    if !valid_kind(&kind) {
        return Err("type de mémoire inconnu".into());
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("souvenir vide".into());
    }
    if text.len() > 8192 {
        return Err("souvenir trop long".into());
    }
    if !store.policy().await.can_write(&context, &kind) {
        return Err(format!(
            "accès refusé : « {context} » ne peut pas écrire la mémoire « {kind} »"
        ));
    }
    let now = now_ms();
    let item = MemoryItem {
        id: format!("mem-{now}-{}", now % 1000),
        kind: kind.clone(),
        text,
        tags: tags.unwrap_or_default(),
        source: source.unwrap_or(context),
        salience: salience.unwrap_or(0.5).clamp(0.0, 1.0),
        pinned: false,
        created_at: now,
        updated_at: now,
        last_access: now,
        access_count: 0,
        expires_at: ttl_ms.or(if kind == "session" { Some(SESSION_TTL_MS) } else { None }).map(|t| now + t),
        meta: meta.unwrap_or(Value::Null),
    };
    let mut items = store.load(&kind).await;
    items.insert(0, item.clone());
    store.save(&kind, items).await;
    Ok(item)
}

/// Rappelle les souvenirs les plus pertinents, en ne balayant QUE les types
/// lisibles par ce `context`. Renforce (accès) les items renvoyés.
#[tauri::command]
pub async fn mem_recall(
    store: tauri::State<'_, RecallStore>,
    context: String,
    query: Option<String>,
    kinds: Option<Vec<String>>,
    limit: Option<usize>,
) -> Result<Vec<ScoredItem>, String> {
    let pol = store.policy().await;
    let now = now_ms();
    let limit = limit.unwrap_or(8).min(50);
    let q_tokens = tokenize(query.as_deref().unwrap_or(""));

    let wanted: Vec<String> = kinds
        .unwrap_or_else(|| KINDS.iter().map(|s| s.to_string()).collect())
        .into_iter()
        .map(|k| legacy_kind(&k).to_string())
        .filter(|k| valid_kind(k) && pol.can_read(&context, k))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();

    let mut scored: Vec<ScoredItem> = Vec::new();
    for kind in &wanted {
        for item in store.load(kind).await {
            if item.is_expired(now) {
                continue;
            }
            let score = relevance(&q_tokens, &item, now);
            // Avec requête, on écarte le bruit non pertinent.
            if !q_tokens.is_empty() && lexical(&q_tokens, &item) == 0.0 && !item.pinned {
                continue;
            }
            scored.push(ScoredItem { item, score });
        }
    }
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(limit);

    // Renforcement : marque les items rappelés comme accédés (par type touché).
    let touched: std::collections::BTreeSet<String> =
        scored.iter().map(|s| s.item.kind.clone()).collect();
    let ids: std::collections::BTreeSet<String> =
        scored.iter().map(|s| s.item.id.clone()).collect();
    for kind in touched {
        let mut items = store.load(&kind).await;
        let mut changed = false;
        for it in items.iter_mut() {
            if ids.contains(&it.id) {
                it.access_count += 1;
                it.last_access = now;
                changed = true;
            }
        }
        if changed {
            store.save(&kind, items).await;
        }
    }
    Ok(scored)
}

/// Liste brute d'un type (UI / inspection). Soumis à la lecture.
#[tauri::command]
pub async fn mem_list(
    store: tauri::State<'_, RecallStore>,
    context: String,
    kind: String,
) -> Result<Vec<MemoryItem>, String> {
    let kind = legacy_kind(&kind).to_string();
    if !valid_kind(&kind) {
        return Err("type de mémoire inconnu".into());
    }
    if !store.policy().await.can_read(&context, &kind) {
        return Err("accès refusé en lecture".into());
    }
    let now = now_ms();
    let mut items = store.load(&kind).await;
    items.retain(|i| !i.is_expired(now));
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}

/// Compte par type — pour l'app Mémoire. Réservé aux gestionnaires.
#[tauri::command]
pub async fn mem_stats(
    store: tauri::State<'_, RecallStore>,
    context: String,
) -> Result<Value, String> {
    if !is_manager(&context) {
        return Err("accès réservé".into());
    }
    let now = now_ms();
    let mut out = serde_json::Map::new();
    for kind in KINDS {
        let n = store
            .load(kind)
            .await
            .into_iter()
            .filter(|i| !i.is_expired(now))
            .count();
        out.insert(kind.to_string(), json!(n));
    }
    Ok(Value::Object(out))
}

/// Met à jour un item (texte / saillance / tags / épingle). Gestionnaire requis.
#[tauri::command]
pub async fn mem_update(
    store: tauri::State<'_, RecallStore>,
    context: String,
    kind: String,
    id: String,
    text: Option<String>,
    salience: Option<f32>,
    tags: Option<Vec<String>>,
    pinned: Option<bool>,
) -> Result<bool, String> {
    if !is_manager(&context) {
        return Err("accès réservé".into());
    }
    let kind = legacy_kind(&kind).to_string();
    if !valid_kind(&kind) {
        return Err("type de mémoire inconnu".into());
    }
    let mut items = store.load(&kind).await;
    let Some(it) = items.iter_mut().find(|i| i.id == id) else {
        return Ok(false);
    };
    if let Some(t) = text {
        it.text = t.trim().to_string();
    }
    if let Some(s) = salience {
        it.salience = s.clamp(0.0, 1.0);
    }
    if let Some(tg) = tags {
        it.tags = tg;
    }
    if let Some(p) = pinned {
        it.pinned = p;
    }
    it.updated_at = now_ms();
    store.save(&kind, items).await;
    Ok(true)
}

/// Oublie un item. Gestionnaire requis.
#[tauri::command]
pub async fn mem_forget(
    store: tauri::State<'_, RecallStore>,
    context: String,
    kind: String,
    id: String,
) -> Result<bool, String> {
    if !is_manager(&context) {
        return Err("accès réservé".into());
    }
    let kind = legacy_kind(&kind).to_string();
    if !valid_kind(&kind) {
        return Err("type de mémoire inconnu".into());
    }
    let mut items = store.load(&kind).await;
    let before = items.len();
    items.retain(|i| i.id != id);
    let removed = items.len() != before;
    if removed {
        store.save(&kind, items).await;
    }
    Ok(removed)
}

/// Purge totale d'un type (« panique »). Gestionnaire requis.
#[tauri::command]
pub async fn mem_wipe(
    store: tauri::State<'_, RecallStore>,
    context: String,
    kind: String,
) -> Result<usize, String> {
    if !is_manager(&context) {
        return Err("accès réservé".into());
    }
    let kind = legacy_kind(&kind).to_string();
    if !valid_kind(&kind) {
        return Err("type de mémoire inconnu".into());
    }
    let n = store.load(&kind).await.len();
    store.save(&kind, Vec::new()).await;
    Ok(n)
}

/// CONSOLIDATION : digère les souvenirs ÉPISODIQUES récents (non encore traités)
/// en connaissances durables — faits SÉMANTIQUES, habitudes COMPORTEMENTALES et
/// un résumé NARRATIF — via le LLM actif. Idempotent : les épisodes traités sont
/// marqués (`meta.consolidated`) pour ne pas être redigérés. Réservé aux
/// gestionnaires (app Mémoire, heartbeat, bloc Fluxo via le serveur loopback).
#[tauri::command]
pub async fn mem_consolidate(
    app: tauri::AppHandle,
    store: tauri::State<'_, RecallStore>,
    context: String,
) -> Result<Value, String> {
    if !is_manager(&context) {
        return Err("accès réservé".into());
    }
    consolidate(&app, &store).await
}

/// Cœur de la consolidation, réutilisable hors contexte de commande (route
/// loopback du bloc Fluxo, heartbeat…). cf. `mem_consolidate`.
pub async fn consolidate(app: &tauri::AppHandle, store: &RecallStore) -> Result<Value, String> {
    let now = now_ms();
    // Matière : épisodes ET mémoire de session pas encore digérés.
    let mut sources: Vec<(String, Vec<MemoryItem>)> = Vec::new();
    for kind in ["episodic", "session"] {
        sources.push((kind.to_string(), store.load(kind).await));
    }
    let mut pending: Vec<(String, usize, String)> = Vec::new();
    for (kind, items) in &sources {
        for (i, e) in items.iter().enumerate() {
            if e.is_expired(now) || e.meta.get("consolidated").and_then(|v| v.as_bool()) == Some(true) {
                continue;
            }
            if pending.len() >= 80 { break; }
            pending.push((kind.clone(), i, e.text.clone()));
        }
    }
    if pending.is_empty() {
        return Ok(json!({ "consolidated": 0, "message": "Rien de nouveau à consolider." }));
    }
    let digest = pending.iter().map(|(k, _, t)| format!("- [{k}] {t}")).collect::<Vec<_>>().join("\n");

    let default_system = "Tu es le processus de consolidation mnésique de Lumen. À partir d'ÉVÉNEMENTS \
récents et de notes de SESSION, extrais des connaissances DURABLES. Réponds STRICTEMENT en JSON, \
sans markdown : {\"semantic\":[\"fait stable : sur l'utilisateur (goûts, préférences, proches, projets) ou le monde\"],\
\"procedural\":[\"façon de faire, routine ou méthode qui a fonctionné (« pour X, faire Y puis Z »)\"],\
\"summary\":\"2-3 phrases résumant la période\"}. N'invente rien : appuie-toi uniquement sur la matière. \
Ignore ce qui est éphémère. Max 6 éléments par liste. Écris en français.";
    let system = crate::prompts::resolve(app, "memory.consolidate", default_system);
    let user = format!("Matière à consolider :\n{digest}");
    let raw = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || crate::agents::complete_llm(&app, &system, &user)
    })
    .await
    .map_err(|e| format!("Tâche interrompue : {e}"))??;

    let parsed: Value = serde_json::from_str(&raw)
        .or_else(|_| {
            let start = raw.find('{');
            let end = raw.rfind('}');
            match (start, end) {
                (Some(s), Some(e)) if e > s => serde_json::from_str(&raw[s..=e]),
                _ => Ok(Value::Null),
            }
        })
        .unwrap_or(Value::Null);
    let as_list = |v: &Value, key: &str| -> Vec<String> {
        v.get(key).and_then(|x| x.as_array()).map(|a| {
            a.iter().filter_map(|s| s.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
        }).unwrap_or_default()
    };
    let semantic = as_list(&parsed, "semantic");
    let procedural = as_list(&parsed, "procedural");
    let summary = parsed.get("summary").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    let mut added = 0usize;
    for (kind, list) in [("semantic", &semantic), ("procedural", &procedural)] {
        let mut items = store.load(kind).await;
        let existing: std::collections::BTreeSet<String> = items.iter().map(|i| i.text.to_lowercase()).collect();
        for text in list {
            if existing.contains(&text.to_lowercase()) { continue; }
            items.insert(0, MemoryItem {
                id: format!("mem-{}-{}", now_ms(), added),
                kind: kind.to_string(),
                text: text.clone(),
                tags: vec!["consolidation".into()],
                source: "Consolidation".into(),
                salience: 0.6,
                pinned: false,
                created_at: now, updated_at: now, last_access: now, access_count: 0,
                expires_at: None,
                meta: Value::Null,
            });
            added += 1;
        }
        store.save(kind, items).await;
    }
    // Résumé de période : un épisode (il garde la trace de ce qui a été vécu).
    if let Some(text) = summary.clone() {
        let mut items = store.load("episodic").await;
        items.insert(0, MemoryItem {
            id: format!("mem-{}-sum", now_ms()),
            kind: "episodic".into(),
            text,
            tags: vec!["résumé".into(), "consolidation".into()],
            source: "Consolidation".into(),
            salience: 0.7,
            pinned: false,
            created_at: now, updated_at: now, last_access: now, access_count: 0,
            expires_at: None,
            meta: json!({ "consolidated": true }),
        });
        store.save("episodic", items).await;
    }
    // Marque la matière traitée (rechargée : le résumé a pu décaler les index).
    for kind in ["episodic", "session"] {
        let marked: std::collections::BTreeSet<String> = pending.iter().filter(|(k, _, _)| k == kind).map(|(_, _, t)| t.clone()).collect();
        if marked.is_empty() { continue; }
        let mut items = store.load(kind).await;
        for e in items.iter_mut() {
            if marked.contains(&e.text) {
                if !e.meta.is_object() { e.meta = json!({}); }
                if let Some(obj) = e.meta.as_object_mut() { obj.insert("consolidated".into(), Value::Bool(true)); }
            }
        }
        store.save(kind, items).await;
    }
    Ok(json!({
        "consolidated": pending.len(),
        "semantic_added": semantic.len(),
        "procedural_added": procedural.len(),
        "summary": summary.is_some(),
    }))
}

/// Politique courante (table context→kind→accès) + métadonnées d'aide pour l'UI.
#[tauri::command]
pub async fn mem_policy_get(
    store: tauri::State<'_, RecallStore>,
    context: String,
) -> Result<Value, String> {
    if !is_manager(&context) {
        return Err("accès réservé".into());
    }
    Ok(json!({
        "kinds": KINDS,
        "policy": store.policy().await,
    }))
}

/// Remplace la politique. Gestionnaire requis. Valide les types et les accès.
#[tauri::command]
pub async fn mem_policy_set(
    store: tauri::State<'_, RecallStore>,
    context: String,
    policy: Policy,
) -> Result<(), String> {
    if !is_manager(&context) {
        return Err("accès réservé".into());
    }
    let mut policy = policy;
    for row in policy.table.values_mut() {
        let keys: Vec<String> = row.keys().cloned().collect();
        for k in keys {
            let n = legacy_kind(&k).to_string();
            if n != k { if let Some(a) = row.remove(&k) { row.entry(n).or_insert(a); } }
        }
    }
    for kinds in policy.table.values() {
        for (k, a) in kinds {
            if !KINDS.contains(&k.as_str()) {
                return Err(format!("type inconnu : {k}"));
            }
            if !matches!(a.as_str(), "none" | "read" | "write") {
                return Err(format!("accès invalide : {a}"));
            }
        }
    }
    *store.policy.lock().await = policy;
    store.persist_policy().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Accès interne (code Rust synchrone : agents, passerelles)
// ---------------------------------------------------------------------------

/// Mémorise en tâche de fond (n'attend pas, ne bloque pas l'appelant). Même
/// politique d'accès que la commande : un refus est simplement ignoré.
pub fn remember_bg(app: &tauri::AppHandle, context: &str, kind: &str, text: String, tags: Vec<String>, source: &str) {
    let app = app.clone();
    let (context, kind, source) = (context.to_string(), legacy_kind(kind).to_string(), source.to_string());
    tauri::async_runtime::spawn(async move {
        let store = app.state::<RecallStore>();
        let _ = mem_remember(store, context, kind, text, Some(tags), None, Some(source), None, None).await;
    });
}

/// Rappel synchrone (lecture seule des fichiers, politique respectée). Utilisé
/// pour nourrir le prompt d'un agent avant sa tâche.
pub fn recall_blocking(app: &tauri::AppHandle, context: &str, query: &str, kinds: &[&str], limit: usize) -> Vec<MemoryItem> {
    let store = app.state::<RecallStore>();
    let Ok(pol) = store.policy.try_lock().map(|p| p.clone()) else { return Vec::new() };
    let Ok(dir) = crate::paths::shared_data_dir(app.path()).map(|d| d.join("recall")) else { return Vec::new() };
    let now = now_ms();
    let q = tokenize(query);
    let mut scored: Vec<(f32, MemoryItem)> = Vec::new();
    for kind in kinds {
        if !pol.can_read(context, kind) { continue; }
        for item in RecallStore::read_kind_file(&dir.join(format!("{kind}.json"))) {
            if item.is_expired(now) { continue; }
            if !q.is_empty() && lexical(&q, &item) == 0.0 && !item.pinned { continue; }
            scored.push((relevance(&q, &item, now), item));
        }
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(limit).map(|(_, i)| i).collect()
}

/// Bloc de prompt « ce que Lumen sait » pour une tâche (vide si rien).
pub fn prompt_block(app: &tauri::AppHandle, context: &str, query: &str) -> String {
    let items = recall_blocking(app, context, query, &["semantic", "procedural"], 6);
    if items.is_empty() { return String::new(); }
    let lines: Vec<String> = items.iter().map(|i| format!("- ({}) {}", if i.kind == "procedural" { "méthode" } else { "fait" }, i.text)).collect();
    format!("\n\n=== Mémoire de Lumen utile pour cette tâche (faits et méthodes connus) ===\n{}", lines.join("\n"))
}
