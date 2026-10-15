//! Coffre de données partagé (façon Data Jar) entre Lumen et ses appareils.
//!
//! Un magasin clé → valeur TYPÉE, rangé en dossiers par des « / » dans la clé
//! (`maison/chauffage`, `sante/pas`, `courses`). Il est lu et écrit par :
//! le chat et les agents (outils natifs vault_*), les Raccourcis iOS et les
//! widgets (app iOS), les capteurs de l'iPhone (santé, lieux, agenda), Fluxo.
//!
//! ## Synchronisation
//!
//! Chaque entrée porte `updated_ms` et l'appareil auteur. L'iPhone garde une
//! copie locale, écrit hors ligne, puis pousse ses changements
//! (`POST /vault/sync`) et récupère ceux de Lumen depuis son dernier passage.
//! Conflit : la dernière écriture gagne ; la version perdante reste dans
//! l'historique de l'entrée (10 versions). Une suppression est une pierre
//! tombale datée, pour qu'elle se propage elle aussi.
//!
//! Un fichier par profil (`vault/<profil>.json`, 0600).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const HISTORY: usize = 10;
const MAX_VALUE_BYTES: usize = 256 * 1024;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Version {
    pub value: Value,
    pub updated_ms: u64,
    #[serde(default)]
    pub device: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Entry {
    pub key: String,
    /// "text" | "number" | "bool" | "date" | "list" | "dict" | "json"
    #[serde(rename = "type")]
    pub kind: String,
    pub value: Value,
    pub updated_ms: u64,
    #[serde(default)]
    pub device: String,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<Version>,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    collections: BTreeMap<String, Collection>,
    #[serde(default)]
    entries: BTreeMap<String, Entry>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Field {
    pub name: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub required: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Collection {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub fields: Vec<Field>,
    /// none / read / write. Owner commands remain available in all cases.
    #[serde(default = "default_access")]
    pub ai_access: String,
    #[serde(default)]
    pub updated_ms: u64,
}
fn default_access() -> String { "read".into() }

fn collection_for<'a>(store: &'a Store, key: &str) -> Option<&'a Collection> {
    store.collections.values().filter(|c| key == c.id || key.starts_with(&format!("{}/",c.id))).max_by_key(|c| c.id.len())
}
fn allowed(store: &Store, key: &str, writing: bool) -> bool {
    collection_for(store,key).map(|c| if writing { c.ai_access == "write" } else { c.ai_access != "none" }).unwrap_or(true)
}
fn validate_record(store: &Store, key: &str, value: &Value) -> Result<(), String> {
    let Some(c) = collection_for(store,key) else { return Ok(()) };
    let obj = value.as_object().ok_or("Une fiche doit être un objet JSON")?;
    for f in &c.fields {
        let v = obj.get(&f.name).unwrap_or(&Value::Null);
        if v.is_null() || v == "" {
            if f.required { return Err(format!("Champ requis : {}",f.label)); }
            continue;
        }
        let valid = match f.kind.as_str() {
            "text" => v.is_string(), "date" => v.as_str().map(looks_like_date).unwrap_or(false),
            "number" => v.is_number(), "bool" => v.is_boolean(), "list" => v.is_array(), "dict" => v.is_object(), _ => false,
        };
        if !valid { return Err(format!("Type incorrect pour {} : {} attendu",f.label,f.kind)); }
    }
    if !c.fields.is_empty() && obj.keys().any(|key| !c.fields.iter().any(|f| &f.name == key)) {
        return Err("Champ inconnu : modifiez d’abord la structure de la collection".into());
    }
    Ok(())
}

static LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn path(app: &tauri::AppHandle, profile: &str) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?.join("vault");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = profile.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
    Ok(dir.join(format!("{}.json", if safe.is_empty() { "default" } else { &safe })))
}

fn read_checked(app: &tauri::AppHandle, profile: &str) -> Result<Store,String> {
    let p=path(app,profile)?;
    match std::fs::read_to_string(p) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("Coffre illisible : {e}. Les données ont été conservées.")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(e.to_string()),
    }
}
fn read(app: &tauri::AppHandle, profile: &str) -> Store { read_checked(app,profile).unwrap_or_default() }

fn write(app: &tauri::AppHandle, profile: &str, store: &Store) -> Result<(), String> {
    use std::io::Write;
    let p = path(app,profile)?;
    let temp = p.with_extension("json.pending");
    let mut options=std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file=options.open(&temp).map_err(|e|e.to_string())?;
    file.write_all(serde_json::to_string_pretty(store).map_err(|e|e.to_string())?.as_bytes()).map_err(|e|e.to_string())?;
    file.sync_all().map_err(|e|e.to_string())?;
    drop(file);
    std::fs::rename(&temp,&p).map_err(|e|e.to_string())?;
    Ok(())
}

/// Clé normalisée : minuscules, sans espaces aux bords, « / » comme séparateur.
pub fn norm_key(key: &str) -> Result<String, String> {
    let k = key.trim().trim_matches('/').to_lowercase();
    if k.is_empty() || k.len() > 200 || k.contains("//") || k.chars().any(|c| c.is_control()) {
        return Err(format!("clé invalide : « {key} »"));
    }
    Ok(k)
}

/// Type déduit d'une valeur JSON.
pub fn kind_of(v: &Value) -> &'static str {
    match v {
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
        Value::String(s) if looks_like_date(s) => "date",
        _ => "text",
    }
}

fn looks_like_date(s: &str) -> bool {
    s.len() >= 10 && s.as_bytes().get(4) == Some(&b'-') && s.as_bytes().get(7) == Some(&b'-') && s.as_bytes().iter().take(4).all(|c| c.is_ascii_digit())
}

/// Applique une écriture (dernière écriture gagne). Renvoie vrai si l'état a changé.
fn apply(store: &mut Store, incoming: Entry) -> bool {
    match store.entries.get_mut(&incoming.key) {
        Some(cur) if cur.updated_ms >= incoming.updated_ms => {
            // Plus ancien que ce qu'on a : on le garde seulement dans l'historique.
            if cur.value != incoming.value && !incoming.deleted {
                push_history(cur, Version { value: incoming.value, updated_ms: incoming.updated_ms, device: incoming.device });
            }
            false
        }
        Some(cur) => {
            let old = Version { value: cur.value.clone(), updated_ms: cur.updated_ms, device: cur.device.clone() };
            let history = std::mem::take(&mut cur.history);
            *cur = Entry { history, ..incoming };
            if !old.value.is_null() {
                push_history(cur, old);
            }
            true
        }
        None => {
            store.entries.insert(incoming.key.clone(), incoming);
            true
        }
    }
}

fn push_history(e: &mut Entry, v: Version) {
    e.history.insert(0, v);
    e.history.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    e.history.truncate(HISTORY);
}

fn notify(app: &tauri::AppHandle, profile: &str, changed: &[Entry]) {
    if changed.is_empty() {
        return;
    }
    let light: Vec<Value> = changed.iter().map(light_entry).collect();
    let active = crate::session::active_profile_id(app) == profile;
    if active { let _ = app.emit("vault-changed", &light); crate::datahub::touch(app); }
    // Workflows Fluxo déclenchés par une clé (Webhook « vault/<clé> »).
    for (e, l) in changed.iter().zip(light.iter()).filter(|_|active) {
        crate::dispatch_path_triggers(app, format!("vault/{}", e.key), l.to_string());
    }
    crate::companion::push_to_phones(app, serde_json::json!({ "type": "vault", "vault_profile":profile, "entries": light }));
}

fn light_entry(e: &Entry) -> Value {
    serde_json::json!({ "key": e.key, "type": e.kind, "value": e.value, "updated_ms": e.updated_ms, "device": e.device, "deleted": e.deleted })
}

// ===== API interne (outils natifs, routes, commandes) =====

pub fn get(app: &tauri::AppHandle, profile: &str, key: &str) -> Option<Entry> {
    let key = norm_key(key).ok()?;
    read(app, profile).entries.get(&key).filter(|e| !e.deleted).cloned()
}

/// Entrées vivantes sous un préfixe (« » = tout).
pub fn list(app: &tauri::AppHandle, profile: &str, prefix: &str) -> Vec<Entry> {
    let prefix = prefix.trim().trim_matches('/').to_lowercase();
    read(app, profile)
        .entries
        .into_values()
        .filter(|e| !e.deleted && (prefix.is_empty() || e.key == prefix || e.key.starts_with(&format!("{prefix}/"))))
        .map(|e| Entry { history: vec![], ..e })
        .collect()
}

pub fn set(app: &tauri::AppHandle, profile: &str, key: &str, value: Value, kind: Option<&str>, device: &str) -> Result<Entry, String> {
    let key = norm_key(key)?;
    if serde_json::to_string(&value).map(|s| s.len()).unwrap_or(0) > MAX_VALUE_BYTES {
        return Err("valeur trop volumineuse (256 Ko max)".into());
    }
    let _g = LOCK.lock().map_err(|_| "coffre occupé")?;
    let mut store = read_checked(app, profile)?;
    validate_record(&store, &key, &value)?;
    if device == "Lumen" && !allowed(&store,&key,true) { return Err("Cette collection interdit l’écriture par l’IA".into()); }
    let entry = Entry {
        kind: kind.map(str::to_string).unwrap_or_else(|| kind_of(&value).to_string()),
        key: key.clone(),
        value,
        updated_ms: now_ms().max(store.entries.get(&key).map(|e| e.updated_ms + 1).unwrap_or(0)),
        device: device.into(),
        deleted: false,
        history: vec![],
    };
    apply(&mut store, entry);
    write(app, profile, &store)?;
    let saved = store.entries.get(&key).cloned().ok_or("écriture perdue")?;
    drop(_g);
    notify(app, profile, std::slice::from_ref(&saved));
    Ok(saved)
}

/// Ajoute un élément à une liste (la crée si besoin).
pub fn append(app: &tauri::AppHandle, profile: &str, key: &str, item: Value, device: &str) -> Result<Entry, String> {
    let key=norm_key(key)?;
    let lock=LOCK.lock().map_err(|_|"coffre occupé")?;
    let mut store=read_checked(app,profile)?;
    if device=="Lumen" && !allowed(&store,&key,true) { return Err("Cette collection interdit l’écriture par l’IA".into()); }
    let current=store.entries.get(&key).filter(|e|!e.deleted);
    let mut values=match current.map(|e|e.value.clone()) {Some(Value::Array(a))=>a,Some(Value::Null)|None=>vec![],Some(v)=>vec![v]};
    values.push(item);
    let value=Value::Array(values);
    validate_record(&store,&key,&value)?;
    if value.to_string().len()>MAX_VALUE_BYTES {return Err("Liste trop volumineuse".into());}
    let updated=now_ms().max(store.entries.get(&key).map(|e|e.updated_ms+1).unwrap_or(0));
    apply(&mut store,Entry{key:key.clone(),kind:"list".into(),value,updated_ms:updated,device:device.into(),deleted:false,history:vec![]});
    write(app,profile,&store)?;
    let saved=store.entries.get(&key).cloned().ok_or("écriture perdue")?;
    drop(lock);notify(app,profile,std::slice::from_ref(&saved));Ok(saved)
}

pub fn delete(app: &tauri::AppHandle, profile: &str, key: &str, device: &str) -> Result<(), String> {
    let key = norm_key(key)?;
    let _g = LOCK.lock().map_err(|_| "coffre occupé")?;
    let mut store = read_checked(app, profile)?;
    let Some(cur) = store.entries.get(&key).cloned() else { return Ok(()) };
    let tomb = Entry { key: key.clone(), kind: cur.kind.clone(), value: Value::Null, updated_ms: now_ms().max(cur.updated_ms + 1), device: device.into(), deleted: true, history: vec![] };
    apply(&mut store, tomb);
    write(app, profile, &store)?;
    let saved = store.entries.get(&key).cloned();
    drop(_g);
    if let Some(e) = saved {
        notify(app, profile, &[e]);
    }
    Ok(())
}

/// Synchronisation d'un appareil : fusionne ses changements, renvoie tout ce
/// qui a bougé depuis `since_ms` (pierres tombales comprises).
pub fn sync(app: &tauri::AppHandle, profile: &str, since_ms: u64, changes: Vec<Entry>, device: &str) -> Result<(Vec<Value>, u64), String> {
    if changes.len()>2000 {return Err("Synchronisation limitée à 2000 fiches".into());}
    let mut changed = vec![];
    {
        let _g = LOCK.lock().map_err(|_| "coffre occupé")?;
        let mut store = read_checked(app, profile)?;
        for mut c in changes {
            let k = norm_key(&c.key)?;
            c.key = k.clone();
            if c.device.is_empty() {
                c.device = device.into();
            }
            if c.kind.is_empty() {
                c.kind = kind_of(&c.value).into();
            }
            if !c.deleted { validate_record(&store,&c.key,&c.value)?; }
            if c.value.to_string().len()>MAX_VALUE_BYTES {return Err("Fiche trop volumineuse".into());}
            c.history.clear();
            if apply(&mut store, c) {
                if let Some(e) = store.entries.get(&k) {
                    changed.push(e.clone());
                }
            }
        }
        if !changed.is_empty() {
            write(app, profile, &store)?;
        }
    }
    notify(app, profile, &changed);
    let store = read(app, profile);
    let out: Vec<Value> = store.entries.values().filter(|e| e.updated_ms > since_ms).map(light_entry).collect();
    Ok((out, now_ms()))
}

/// Texte lisible d'une valeur (pour le modèle, les notifications).
pub fn display(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(display).collect::<Vec<_>>().join(", "),
        Value::Null => "—".into(),
        other => crate::datahub::readable(other),
    }
}

/// Valeur tapée par une personne ou un modèle : on respecte le type demandé.
pub fn parse_value(raw: &Value, kind: &str) -> Value {
    let s = match raw {
        Value::String(s) => s.trim().to_string(),
        other => return other.clone(),
    };
    match kind {
        "number" => s.replace(',', ".").parse::<f64>().map(|n| serde_json::json!(n)).unwrap_or(Value::String(s)),
        "bool" => Value::Bool(matches!(s.to_lowercase().as_str(), "true" | "vrai" | "oui" | "yes" | "1" | "on")),
        "list" => serde_json::from_str::<Value>(&s)
            .ok()
            .filter(|v| v.is_array())
            .unwrap_or_else(|| Value::Array(s.split(',').map(|x| Value::String(x.trim().to_string())).filter(|x| x != &Value::String(String::new())).collect())),
        "dict" | "json" => serde_json::from_str(&s).unwrap_or(Value::String(s)),
        _ => Value::String(s),
    }
}

fn active(app: &tauri::AppHandle) -> String {
    crate::session::active_profile_id(app)
}

// ===== Commandes Tauri (app Coffre du bureau, Fluxo) =====

#[tauri::command]
pub fn vault_list(app: tauri::AppHandle, prefix: Option<String>) -> Vec<Entry> {
    if owner(&app).is_err() { return vec![]; }
    list(&app, &active(&app), prefix.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn vault_get(app: tauri::AppHandle, key: String) -> Option<Entry> {
    let profile = owner(&app).ok()?;
    let key = norm_key(&key).ok()?;
    read(&app, &profile).entries.get(&key).filter(|e| !e.deleted).cloned()
}

#[tauri::command]
pub fn vault_set(app: tauri::AppHandle, key: String, value: Value, kind: Option<String>) -> Result<Entry, String> {
    let kind = kind.filter(|k| !k.is_empty());
    let value = match &kind { Some(k) => parse_value(&value, k), None => value };
    set(&app, &owner(&app)?, &key, value, kind.as_deref(), "ordinateur")
}

#[tauri::command]
pub fn vault_append(app: tauri::AppHandle, key: String, item: Value) -> Result<Entry, String> {
    append(&app, &owner(&app)?, &key, item, "ordinateur")
}

#[tauri::command]
pub fn vault_delete(app: tauri::AppHandle, key: String) -> Result<(), String> {
    delete(&app, &owner(&app)?, &key, "ordinateur")
}

// ===== Collections and transactional records =====
fn owner(app: &tauri::AppHandle) -> Result<String,String> {
    crate::session::require_unlocked(app,app.state::<crate::session::SessionState>().inner())?;
    Ok(active(app))
}
pub fn ai_list(app: &tauri::AppHandle, profile: &str, prefix: &str) -> Vec<Entry> {
    let store=read(app,profile);
    list(app,profile,prefix).into_iter().filter(|e| allowed(&store,&e.key,false)).collect()
}
pub fn ai_get(app: &tauri::AppHandle, profile: &str, key: &str) -> Option<Entry> {
    let key=norm_key(key).ok()?;
    if !allowed(&read(app,profile),&key,false) { return None; }
    get(app,profile,&key)
}
pub fn ai_schema(app: &tauri::AppHandle, profile: &str) -> Value {
    let store=read(app,profile);
    serde_json::to_value(store.collections.values().filter(|c| c.ai_access != "none").collect::<Vec<_>>()).unwrap_or(Value::Null)
}
pub fn query_records(app: &tauri::AppHandle, profile: &str, collection: &str, query: &str, filter: &Value, limit: usize, offset: usize, ai: bool) -> Result<Value,String> {
    let store=read_checked(app,profile)?;
    if ai && !allowed(&store,collection,false) { return Err("Collection inaccessible à l’IA".into()); }
    let list=if ai { ai_list(app,profile,collection) } else { list(app,profile,collection) };
    let query=query.to_lowercase();
    if !filter.is_null() && !filter.is_object() { return Err("Le filtre doit être un objet champ → valeur".into()); }
    let matches:Vec<Entry>=list.into_iter().filter(|e| (query.is_empty() || format!("{} {}",e.key,e.value).to_lowercase().contains(&query)) && filter.as_object().map(|f| f.iter().all(|(k,v)| e.value.get(k)==Some(v))).unwrap_or(true)).collect();
    let total=matches.len();
    Ok(serde_json::json!({"total":total,"offset":offset,"records":matches.into_iter().skip(offset).take(limit.clamp(1,200)).collect::<Vec<_>>()}))
}

#[tauri::command]
pub fn vault_files(app: tauri::AppHandle, source: String, path: String, offset: usize) -> Result<Value,String> {
    let profile=owner(&app)?;
    if source.is_empty(){crate::vault_files::roots(&app,&profile)}else{crate::vault_files::browse(&app,&profile,&source,&path,offset)}
}
#[tauri::command]
pub fn vault_sources(app: tauri::AppHandle, source: String, query: String, offset: usize) -> Result<Value,String> {
    let profile=owner(&app)?;
    crate::datahub::browse_as(&app,&profile,&source,&query,offset)
}
#[tauri::command]
pub fn vault_source_get(app: tauri::AppHandle, id: String) -> Result<Value,String> {
    let profile=owner(&app)?;
    serde_json::to_value(crate::datahub::get_exact(&app,&profile,&id)).map_err(|e|e.to_string())
}

#[tauri::command]
pub fn vault_workspace(app: tauri::AppHandle) -> Result<Value,String> {
    let profile=owner(&app)?;
    profile_workspace(app, profile)
}
pub fn profile_workspace(app: tauri::AppHandle, profile: String) -> Result<Value,String> {
    let store=read_checked(&app,&profile)?;
    Ok(serde_json::json!({"collections":store.collections.into_values().collect::<Vec<_>>(),"entries":store.entries.into_values().filter(|e| !e.deleted).map(|e|Entry{history:vec![],..e}).collect::<Vec<_>>()}))
}
#[tauri::command]
pub fn vault_collection_save(app: tauri::AppHandle, collection: Collection, expected_updated: Option<u64>) -> Result<Collection,String> {
    let profile=owner(&app)?;
    profile_collection_save(app, profile, collection, expected_updated)
}
pub fn profile_collection_save(app: tauri::AppHandle, profile: String, mut collection: Collection, expected_updated: Option<u64>) -> Result<Collection,String> {
    collection.id=norm_key(&collection.id)?;
    if collection.name.trim().is_empty() || collection.fields.len()>40 || !["none","read","write"].contains(&collection.ai_access.as_str()) { return Err("Collection invalide".into()); }
    let mut names=std::collections::HashSet::new();
    for f in &collection.fields {
        if ["__proto__","constructor","prototype"].contains(&f.name.as_str()) || f.name.is_empty() || f.name.len()>64 || !f.name.chars().all(|c|c.is_ascii_alphanumeric()||c=='_') || !names.insert(f.name.clone()) || !["text","number","bool","date","list","dict"].contains(&f.kind.as_str()) { return Err("Nom ou type de champ invalide".into()); }
    }
    let lock=LOCK.lock().map_err(|_|"coffre occupé")?;
    let mut store=read_checked(&app,&profile)?;
    let current=store.collections.get(&collection.id).map(|c|c.updated_ms).unwrap_or(0);
    if expected_updated.unwrap_or(0)!=current { return Err("Collection modifiée ailleurs. Actualisez avant d’enregistrer.".into()); }
    collection.updated_ms=now_ms().max(current+1);
    store.collections.insert(collection.id.clone(),collection.clone());
    for e in store.entries.values().filter(|e|!e.deleted) { validate_record(&store,&e.key,&e.value)?; }
    write(&app,&profile,&store)?;drop(lock);
    crate::datahub::refresh(&app,true);
    let _=app.emit("vault-changed",serde_json::json!({"collection":collection.id}));
    Ok(collection)
}
#[tauri::command]
pub fn vault_records_save(app: tauri::AppHandle, records: Vec<Value>) -> Result<Vec<Entry>,String> {
    let profile=owner(&app)?;
    profile_records_save(app, profile, records, "ordinateur")
}
pub fn profile_records_save(app: tauri::AppHandle, profile: String, records: Vec<Value>, device: &str) -> Result<Vec<Entry>,String> {
    if records.is_empty() || records.len()>500 {return Err("Import limité à 500 fiches par opération".into());}
    let lock=LOCK.lock().map_err(|_|"coffre occupé")?;
    let mut store=read_checked(&app,&profile)?;
    let mut saved=vec![];
    for r in records {
        let key=norm_key(r.get("key").and_then(Value::as_str).unwrap_or(""))?;
        let value=r.get("value").cloned().ok_or("Valeur manquante")?;
        validate_record(&store,&key,&value)?;
        if value.to_string().len()>MAX_VALUE_BYTES {return Err("Fiche trop volumineuse".into());}
        let current=store.entries.get(&key).map(|e|e.updated_ms).unwrap_or(0);
        if r.get("expected_updated").and_then(Value::as_u64).unwrap_or(0)!=current {return Err(format!("La fiche {key} a été modifiée ailleurs. Actualisez avant d’enregistrer."));}
        let entry=Entry{key:key.clone(),kind:kind_of(&value).into(),value,updated_ms:now_ms().max(current+1),device:device.into(),deleted:false,history:vec![]};
        apply(&mut store,entry);
        saved.push(store.entries.get(&key).cloned().ok_or("écriture perdue")?);
    }
    write(&app,&profile,&store)?;drop(lock);notify(&app,&profile,&saved);Ok(saved)
}
#[tauri::command]
pub fn vault_record_delete(app: tauri::AppHandle, key: String, expected_updated: u64) -> Result<Entry,String> {
    let profile=owner(&app)?;
    profile_record_delete(app, profile, key, expected_updated, "ordinateur")
}
pub fn profile_record_delete(app: tauri::AppHandle, profile: String, key: String, expected_updated: u64, device: &str) -> Result<Entry,String> {
    let key=norm_key(&key)?;
    let lock=LOCK.lock().map_err(|_|"coffre occupé")?;
    let mut store=read_checked(&app,&profile)?;
    let current=store.entries.get(&key).cloned().ok_or("Fiche introuvable")?;
    if current.updated_ms!=expected_updated {return Err("Fiche modifiée ailleurs. Actualisez avant de supprimer.".into());}
    let tomb=Entry{key:key.clone(),kind:current.kind,value:Value::Null,updated_ms:now_ms().max(current.updated_ms+1),device:device.into(),deleted:true,history:vec![]};
    apply(&mut store,tomb);
    write(&app,&profile,&store)?;
    let saved=store.entries.get(&key).cloned().ok_or("suppression perdue")?;drop(lock);
    notify(&app,&profile,std::slice::from_ref(&saved));Ok(saved)
}

#[tauri::command]
pub fn vault_records_query(app: tauri::AppHandle, collection: String, query: Option<String>, filter: Option<Value>, limit: Option<usize>, offset: Option<usize>) -> Result<Value,String> {
    let profile=owner(&app)?;
    query_records(&app,&profile,&collection,query.as_deref().unwrap_or(""),&filter.unwrap_or(Value::Null),limit.unwrap_or(100),offset.unwrap_or(0),false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(key: &str, v: Value, t: u64, dev: &str) -> Entry {
        Entry { key: key.into(), kind: kind_of(&v).into(), value: v, updated_ms: t, device: dev.into(), deleted: false, history: vec![] }
    }

    #[test]
    fn last_write_wins_and_keeps_history() {
        let mut s = Store::default();
        assert!(apply(&mut s, e("courses", serde_json::json!(["lait"]), 10, "mac")));
        assert!(apply(&mut s, e("courses", serde_json::json!(["lait", "pain"]), 20, "iphone")));
        // Une écriture plus ancienne arrive en retard : ignorée, mais gardée.
        assert!(!apply(&mut s, e("courses", serde_json::json!(["oeufs"]), 15, "watch")));
        let c = &s.entries["courses"];
        assert_eq!(c.value, serde_json::json!(["lait", "pain"]));
        assert_eq!(c.device, "iphone");
        assert_eq!(c.history.len(), 2);
        assert_eq!(c.history[0].value, serde_json::json!(["oeufs"]));
    }

    #[test]
    fn tombstone_propagates() {
        let mut s = Store::default();
        apply(&mut s, e("x", serde_json::json!(1), 10, "mac"));
        let mut t = e("x", Value::Null, 11, "iphone");
        t.deleted = true;
        assert!(apply(&mut s, t));
        assert!(s.entries["x"].deleted);
        // Une écriture plus récente ressuscite la clé.
        assert!(apply(&mut s, e("x", serde_json::json!(2), 12, "mac")));
        assert!(!s.entries["x"].deleted);
    }

    #[test]
    fn collections_validate_fields_and_bound_ai_access() {
        let mut store=Store::default();
        let c=Collection{id:"projets".into(),name:"Projets".into(),description:String::new(),ai_access:"read".into(),updated_ms:1,fields:vec![Field{name:"nom".into(),label:"Nom".into(),kind:"text".into(),required:true},Field{name:"count".into(),label:"Nombre".into(),kind:"number".into(),required:false}]};
        store.collections.insert(c.id.clone(),c);
        assert!(validate_record(&store,"projets/a",&serde_json::json!({"nom":"A","count":2})).is_ok());
        assert!(validate_record(&store,"projets/a",&serde_json::json!({"nom":"A","count":"2"})).is_err());
        assert!(validate_record(&store,"projets/a",&serde_json::json!({"count":2})).is_err());
        assert!(validate_record(&store,"projets/a",&serde_json::json!({"nom":"A","extra":true})).is_err());
        assert!(allowed(&store,"projets/a",false));assert!(!allowed(&store,"projets/a",true));
        store.collections.get_mut("projets").unwrap().ai_access="none".into();
        assert!(!allowed(&store,"projets/a",false));assert!(allowed(&store,"projets-autres/a",false));
        let legacy:Store=serde_json::from_value(serde_json::json!({"entries":{}})).unwrap();assert!(legacy.collections.is_empty());
        assert!(!looks_like_date("éééé-10-10"));
    }

    #[test]
    fn keys_and_types() {
        assert_eq!(norm_key(" Maison/Chauffage/ ").unwrap(), "maison/chauffage");
        assert!(norm_key("a//b").is_err());
        assert_eq!(kind_of(&serde_json::json!("2026-09-26")), "date");
        assert_eq!(parse_value(&serde_json::json!("12,5"), "number"), serde_json::json!(12.5));
        assert_eq!(parse_value(&serde_json::json!("lait, pain"), "list"), serde_json::json!(["lait", "pain"]));
    }
}
