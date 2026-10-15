//! **Espaces partagés de DB Studio** (édition Pro).
//!
//! Un « espace » est une table de DB Studio publiée à d'autres profils de la
//! machine, sous forme d'application autonome : un formulaire de saisie, une
//! vue des données, ou les deux. C'est ce qui permet à la personne qui modélise
//! de donner à ses collègues exactement l'écran dont ils ont besoin, sans leur
//! ouvrir l'atelier de modélisation.
//!
//! # Ce que le droit garantit, et ce qu'il ne garantit pas
//!
//! Chaque bénéficiaire reçoit un droit — `read` ou `write` — vérifié **ici, en
//! Rust**, à chaque appel : l'interface ne fait que refléter une décision prise
//! côté serveur. Un espace en lecture ne dispose d'aucun chemin d'écriture, pas
//! même masqué dans la page.
//!
//! En revanche, ce n'est pas un cloisonnement du système : un profil qui ouvre
//! DB Studio lui-même continue de voir les tables comme avant. Le droit décrit
//! ce que l'ESPACE PARTAGÉ autorise, pas ce que la personne peut faire de toute
//! l'application. Dire l'inverse serait promettre une frontière qui n'existe
//! pas.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::Manager;

/// Droits possibles sur un espace. Volontairement deux, et pas un dégradé de
/// permissions fines : au-delà, personne ne sait plus ce qu'il a partagé.
const READ: &str = "read";
const WRITE: &str = "write";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Share {
    pub id: String,
    /// Nom de l'application telle qu'elle apparaît dans le menu du bureau.
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// "form" (saisie seule), "view" (consultation seule), "both".
    #[serde(default = "default_kind")]
    pub kind: String,
    pub base_id: String,
    pub table_id: String,
    #[serde(default)]
    pub table_name: String,
    /// Profil propriétaire : le seul à pouvoir modifier ou supprimer l'espace.
    pub owner: String,
    /// profil → "read" | "write".
    #[serde(default)]
    pub grants: BTreeMap<String, String>,
    /// Dégradé de la vignette, pour que l'app se reconnaisse dans le menu.
    #[serde(default)]
    pub grad: Vec<String>,
    #[serde(default)]
    pub updated_at: u64,
}

fn default_kind() -> String {
    "both".into()
}

// ===================== Stockage =====================

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("dbstudio_shares.json"))
}

fn read_shares(app: &tauri::AppHandle) -> Vec<Share> {
    store_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_shares(app: &tauri::AppHandle, list: &[Share]) -> Result<(), String> {
    let path = store_path(app)?;
    std::fs::write(&path, serde_json::to_string_pretty(list).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ===================== Droits =====================

fn me(app: &tauri::AppHandle) -> String {
    crate::session::session_active_profile_id(app.clone())
}

/// Droit du profil actif sur cet espace : `""` (aucun), `"read"` ou `"write"`.
/// Le propriétaire écrit toujours — il partage sa propre table.
fn access_of(share: &Share, profile: &str) -> String {
    if share.owner == profile {
        return WRITE.into();
    }
    match share.grants.get(profile).map(|s| s.as_str()) {
        Some(WRITE) => WRITE.into(),
        Some(READ) => READ.into(),
        _ => String::new(),
    }
}

/// Récupère un espace ET vérifie le droit demandé. **Tout chemin de données
/// passe par ici** : il n'existe pas de fonction qui lise ou écrive sans avoir
/// d'abord traversé cette porte.
fn authorize(app: &tauri::AppHandle, id: &str, need_write: bool) -> Result<Share, String> {
    let profile = me(app);
    let share = read_shares(app)
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "Cet espace n'existe pas, ou ne vous est pas partagé.".to_string())?;
    let access = access_of(&share, &profile);
    if access.is_empty() {
        // Même message qu'un espace inexistant : savoir qu'un partage existe
        // est déjà une information.
        return Err("Cet espace n'existe pas, ou ne vous est pas partagé.".into());
    }
    if need_write && access != WRITE {
        return Err(format!("« {} » vous est partagé en lecture seule.", share.name));
    }
    if need_write && share.kind == "view" {
        return Err(format!("« {} » est un espace de consultation : il n'a pas de saisie.", share.name));
    }
    Ok(share)
}

// ===================== Gestion des espaces =====================

/// Espaces visibles par le profil actif : les siens et ceux qu'on lui a
/// partagés. Les autres ne sont pas filtrés côté interface — ils ne sortent
/// tout simplement pas d'ici.
#[tauri::command]
pub fn dbshare_list(app: tauri::AppHandle) -> Vec<Value> {
    let profile = me(&app);
    read_shares(&app)
        .iter()
        .filter_map(|s| {
            let access = access_of(s, &profile);
            if access.is_empty() {
                return None;
            }
            Some(json!({
                "id": s.id, "name": s.name, "description": s.description, "kind": s.kind,
                "tableId": s.table_id, "tableName": s.table_name, "baseId": s.base_id,
                "owner": s.owner, "mine": s.owner == profile,
                "grants": s.grants, "grad": s.grad, "access": access, "updatedAt": s.updated_at,
            }))
        })
        .collect()
}

/// Crée ou met à jour un espace. Seul le propriétaire peut modifier le sien :
/// un bénéficiaire ne peut pas s'octroyer l'écriture.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn dbshare_save(
    app: tauri::AppHandle,
    id: Option<String>,
    name: String,
    description: Option<String>,
    kind: Option<String>,
    base_id: String,
    table_id: String,
    table_name: Option<String>,
    grants: Option<BTreeMap<String, String>>,
    grad: Option<Vec<String>>,
) -> Result<Value, String> {
    if name.trim().is_empty() {
        return Err("Donnez un nom à l'espace : c'est celui qui s'affichera dans le menu.".into());
    }
    let profile = me(&app);
    let mut list = read_shares(&app);
    let id = id.filter(|s| !s.is_empty()).unwrap_or_else(|| format!("shr_{}", now()));
    let existing = list.iter().position(|s| s.id == id);
    if let Some(i) = existing {
        if list[i].owner != profile {
            return Err("Seul le profil qui a créé cet espace peut le modifier.".into());
        }
    }
    // Un droit inconnu ne vaut pas « écriture par défaut » : il est refusé.
    let grants = grants
        .unwrap_or_default()
        .into_iter()
        .filter(|(p, a)| !p.is_empty() && (a == READ || a == WRITE))
        .filter(|(p, _)| *p != profile)
        .collect();

    let share = Share {
        id: id.clone(),
        name: name.trim().to_string(),
        description: description.unwrap_or_default(),
        kind: kind.filter(|k| ["form", "view", "both"].contains(&k.as_str())).unwrap_or_else(default_kind),
        base_id,
        table_id,
        table_name: table_name.unwrap_or_default(),
        owner: existing.map(|i| list[i].owner.clone()).unwrap_or(profile),
        grants,
        grad: grad.unwrap_or_default(),
        updated_at: now(),
    };
    let out = json!({ "id": share.id, "name": share.name });
    match existing {
        Some(i) => list[i] = share,
        None => list.push(share),
    }
    write_shares(&app, &list)?;
    Ok(out)
}

#[tauri::command]
pub fn dbshare_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let profile = me(&app);
    let mut list = read_shares(&app);
    if let Some(s) = list.iter().find(|s| s.id == id) {
        if s.owner != profile {
            return Err("Seul le profil qui a créé cet espace peut le retirer.".into());
        }
    }
    list.retain(|s| s.id != id);
    write_shares(&app, &list)
}

// ===================== Données, sous droit =====================

/// Tout ce qu'il faut pour peindre l'espace : ses métadonnées, le droit du
/// profil, les colonnes typées et le formulaire défini dans DB Studio.
#[tauri::command]
pub fn dbshare_open(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    let share = authorize(&app, &id, false)?;
    let access = access_of(&share, &me(&app));
    let columns = crate::tables::table_schema(app.clone(), share.table_id.clone())?;
    let meta = crate::tables::table_meta_get(app.clone(), share.table_id.clone())?
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}));
    Ok(json!({
        "share": { "id": share.id, "name": share.name, "description": share.description,
                   "kind": share.kind, "tableName": share.table_name, "grad": share.grad },
        "access": access,
        "canWrite": access == WRITE && share.kind != "view",
        "canRead": share.kind != "form",
        "columns": serde_json::to_value(columns).map_err(|e| e.to_string())?,
        "meta": meta,
    }))
}

#[tauri::command]
pub fn dbshare_rows(app: tauri::AppHandle, id: String, limit: Option<i64>, offset: Option<i64>) -> Result<Value, String> {
    let share = authorize(&app, &id, false)?;
    if share.kind == "form" {
        // Un espace de saisie ne montre pas le contenu de la table : la personne
        // dépose une entrée, elle ne consulte pas celles des autres.
        return Ok(json!({ "rows": [], "columns": 0, "hidden": true }));
    }
    crate::tables::table_rows(app, share.table_id, limit, offset)
}

#[tauri::command]
pub fn dbshare_insert(app: tauri::AppHandle, id: String, values: Value) -> Result<i64, String> {
    let share = authorize(&app, &id, true)?;
    crate::tables::table_row_insert(app, share.table_id, values)
}

#[tauri::command]
pub fn dbshare_update(app: tauri::AppHandle, id: String, row_id: i64, values: Value) -> Result<(), String> {
    let share = authorize(&app, &id, true)?;
    crate::tables::table_row_update(app, share.table_id, row_id, values)
}

#[tauri::command]
pub fn dbshare_delete_row(app: tauri::AppHandle, id: String, row_id: i64) -> Result<(), String> {
    let share = authorize(&app, &id, true)?;
    crate::tables::table_row_delete(app, share.table_id, row_id)
}

/// Lignes proposées par un champ « relation » : identifiant et libellé.
///
/// La table visée doit être **la cible d'une relation de la table partagée** —
/// sans ce contrôle, un espace deviendrait une lecture universelle des tables de
/// la machine par simple changement de paramètre.
#[tauri::command]
pub fn dbshare_relation_options(app: tauri::AppHandle, id: String, target_id: String) -> Result<Value, String> {
    let share = authorize(&app, &id, false)?;
    let cols = crate::tables::table_schema(app.clone(), share.table_id.clone())?;
    let cols = serde_json::to_value(&cols).map_err(|e| e.to_string())?;
    let field_meta = |c: &Value| -> Value {
        c.get("meta")
            .and_then(|m| m.as_str())
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or_else(|| json!({}))
    };
    let relation = cols
        .as_array()
        .map(|a| a.iter().map(field_meta).find(|m| m.get("target").and_then(|t| t.as_str()) == Some(target_id.as_str())))
        .unwrap_or(None)
        .ok_or_else(|| "Cette table n'est pas visée par une relation de l'espace.".to_string())?;

    let target_cols = serde_json::to_value(crate::tables::table_schema(app.clone(), target_id.clone())?)
        .map_err(|e| e.to_string())?;
    let empty = Vec::new();
    let target_cols = target_cols.as_array().unwrap_or(&empty).clone();

    // Même règle de libellé que DB Studio : le champ désigné sur la relation,
    // sinon le premier champ texte, sinon l'identifiant.
    let chosen = relation.get("display").and_then(|d| d.as_str()).unwrap_or("");
    let label_col = target_cols
        .iter()
        .find(|c| chosen != "" && c.get("col_id").and_then(|v| v.as_str()) == Some(chosen))
        .or_else(|| {
            target_cols.iter().find(|c| {
                matches!(field_meta(c).get("kind").and_then(|k| k.as_str()), Some("text") | Some("longtext"))
            })
        })
        .or_else(|| target_cols.first())
        .and_then(|c| c.get("col_id").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();

    let rows = crate::tables::table_rows(app, target_id, Some(300), Some(0))?;
    let out: Vec<Value> = rows
        .get("rows")
        .and_then(|r| r.as_array())
        .map(|rows| {
            rows.iter()
                .map(|r| {
                    let rid = r.get("_id").cloned().unwrap_or(Value::Null);
                    let label = r
                        .get(&label_col)
                        .and_then(|v| match v {
                            Value::String(s) => Some(s.clone()),
                            Value::Null => None,
                            other => Some(other.to_string()),
                        })
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| format!("#{rid}"));
                    json!({ "id": rid, "label": label })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn share_with(owner: &str, grants: &[(&str, &str)], kind: &str) -> Share {
        Share {
            id: "s1".into(), name: "Saisie".into(), description: String::new(), kind: kind.into(),
            base_id: "b".into(), table_id: "t".into(), table_name: "T".into(), owner: owner.into(),
            grants: grants.iter().map(|(p, a)| (p.to_string(), a.to_string())).collect(),
            grad: vec![], updated_at: 0,
        }
    }

    #[test]
    fn the_owner_always_writes_and_strangers_get_nothing() {
        let s = share_with("alice", &[("bob", READ)], "both");
        assert_eq!(access_of(&s, "alice"), WRITE);
        assert_eq!(access_of(&s, "bob"), READ);
        assert_eq!(access_of(&s, "mallory"), "");
    }

    #[test]
    fn an_unknown_grant_is_not_a_permission() {
        let s = share_with("alice", &[("bob", "admin")], "both");
        assert_eq!(access_of(&s, "bob"), "");
    }
}
