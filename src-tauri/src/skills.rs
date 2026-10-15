//! Forge de skills : les agents créent et améliorent leurs propres skills sous
//! forme de **workflows Fluxo** — donc réutilisables par tous les agents (et
//! éditables dans le designer), avec **versionnage** de chaque amélioration.
//!
//! Un skill créé ici est un workflow ordinaire du dossier partagé, avec les
//! métadonnées `version` / `created_by` / `description` (cf. fluxo-engine).
//! Avant chaque écrasement, la version courante est photographiée dans
//! `app_data_dir/skill_versions/<slug>/v<N>.json` → rollback possible.
//!
//! Le format « simplifié » échangé avec le LLM (création/amélioration) :
//! ```json
//! { "name": "…", "description": "…",
//!   "steps": [ { "id": "s1", "action": "ollama_generate",
//!                "params": { "prompt": "{{input}}" } } ] }
//! ```
//! Les valeurs de params sont du JSON nu (string/number/bool) converti vers les
//! `Value` Fluxo ; les actions et clés de params sont validées contre le
//! catalogue du moteur avant toute écriture.

use fluxo_engine::{Engine, Value as FluxoValue, Workflow};
use std::fs;
use std::path::PathBuf;

// ===================== Catalogue d'actions =====================

/// Catalogue compact des actions Fluxo (une ligne par action), destiné au LLM :
/// il le consulte via l'outil `list_fluxo_actions` avant de composer un skill.
pub fn actions_catalog() -> String {
    let mut out = String::new();
    for spec in Engine::with_builtins().specs() {
        let params: Vec<String> = spec
            .params
            .iter()
            .map(|p| {
                if p.required {
                    format!("{}*", p.key)
                } else {
                    p.key.clone()
                }
            })
            .collect();
        out.push_str(&format!(
            "- {} : {} (params: {})\n",
            spec.id,
            spec.description,
            if params.is_empty() {
                "aucun".to_string()
            } else {
                params.join(", ")
            }
        ));
    }
    out
}

// ===================== Conversion format simplifié =====================

/// JSON nu → Value Fluxo (récursif pour listes/objets).
fn simple_to_value(v: &serde_json::Value) -> FluxoValue {
    match v {
        serde_json::Value::Null => FluxoValue::Null,
        serde_json::Value::Bool(b) => FluxoValue::Bool(*b),
        serde_json::Value::Number(n) => FluxoValue::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => FluxoValue::Text(s.clone()),
        serde_json::Value::Array(a) => FluxoValue::List(a.iter().map(simple_to_value).collect()),
        serde_json::Value::Object(o) => FluxoValue::Dict(
            o.iter()
                .map(|(k, v)| (k.clone(), simple_to_value(v)))
                .collect(),
        ),
    }
}

/// Value Fluxo → JSON nu (pour présenter les étapes actuelles au LLM).
fn value_to_simple(v: &FluxoValue) -> serde_json::Value {
    match v {
        FluxoValue::Null => serde_json::Value::Null,
        FluxoValue::Bool(b) => serde_json::json!(b),
        FluxoValue::Number(n) => serde_json::json!(n),
        FluxoValue::Text(s) | FluxoValue::File(s) => serde_json::json!(s),
        FluxoValue::List(l) => serde_json::Value::Array(l.iter().map(value_to_simple).collect()),
        FluxoValue::Dict(d) => serde_json::Value::Object(
            d.iter()
                .map(|(k, v)| (k.clone(), value_to_simple(v)))
                .collect(),
        ),
    }
}

/// Étapes d'un workflow au format simplifié (JSON), pour le prompt d'amélioration.
fn steps_to_simple(wf: &Workflow) -> serde_json::Value {
    serde_json::Value::Array(
        wf.steps
            .iter()
            .map(|s| {
                serde_json::json!({
                    "id": s.id,
                    "action": s.action,
                    "params": s.params.iter()
                        .map(|(k, v)| (k.clone(), value_to_simple(v)))
                        .collect::<serde_json::Map<String, serde_json::Value>>(),
                })
            })
            .collect(),
    )
}

/// Parse et VALIDE des étapes simplifiées contre le catalogue du moteur :
/// action connue, clés de params connues, params requis présents.
fn parse_steps(steps_json: &serde_json::Value) -> Result<Vec<fluxo_engine::Step>, String> {
    let specs = Engine::with_builtins().specs();
    let arr = steps_json
        .as_array()
        .ok_or("`steps` doit être un tableau")?;
    if arr.is_empty() {
        return Err("`steps` est vide : un skill doit avoir au moins une étape".into());
    }
    if arr.len() > 30 {
        return Err("Trop d'étapes (max 30)".into());
    }
    let mut out = Vec::new();
    let mut seen_ids = std::collections::BTreeSet::new();
    for (i, s) in arr.iter().enumerate() {
        let action = s
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("étape {} : champ `action` manquant", i + 1))?;
        let spec = specs
            .iter()
            .find(|sp| sp.id == action)
            .ok_or_else(|| format!("étape {} : action inconnue « {action} » — consulte le catalogue (list_fluxo_actions)", i + 1))?;
        let mut params = std::collections::BTreeMap::new();
        if let Some(obj) = s.get("params").and_then(|v| v.as_object()) {
            for (k, v) in obj {
                if !spec.params.iter().any(|p| &p.key == k) {
                    return Err(format!(
                        "étape {} ({action}) : paramètre inconnu « {k} » (attendus : {})",
                        i + 1,
                        spec.params
                            .iter()
                            .map(|p| p.key.clone())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                params.insert(k.clone(), simple_to_value(v));
            }
        }
        for p in spec.params.iter().filter(|p| p.required) {
            if !params.contains_key(&p.key) {
                return Err(format!(
                    "étape {} ({action}) : paramètre requis « {} » manquant",
                    i + 1,
                    p.key
                ));
            }
        }
        let id = s
            .get("id")
            .and_then(|v| v.as_str())
            .map(|x| x.to_string())
            .unwrap_or_else(|| format!("s{}", i + 1));
        let id = if seen_ids.contains(&id) {
            format!("{id}_{}", i + 1)
        } else {
            id
        };
        seen_ids.insert(id.clone());
        out.push(fluxo_engine::Step {
            id,
            action: action.to_string(),
            params,
            name: None,
        });
    }
    Ok(out)
}

// ===================== Versionnage =====================

fn versions_dir(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = crate::paths::shared_data_dir(app.path())
        .map_err(|e| e.to_string())?
        .join("skill_versions")
        .join(crate::fluxo_slug(name));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Photographie un workflow dans son historique (fichier `v<N>.json`).
fn snapshot(app: &tauri::AppHandle, wf: &Workflow) -> Result<(), String> {
    let dir = versions_dir(app, &wf.name)?;
    let v = wf.version.max(1);
    let json = wf.to_json().map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("v{v}.json")), json).map_err(|e| e.to_string())
}

/// Écrit un workflow dans le dossier partagé (même convention de nom de fichier
/// que le designer, pour que Fluxo/Lumen voient le même fichier).
fn write_workflow(app: &tauri::AppHandle, wf: &Workflow) -> Result<(), String> {
    let dir = crate::fluxo_workflows_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", crate::fluxo_slug(&wf.name)));
    let json = wf.to_json().map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

/// Canary statique : recharge le candidat sérialisé et revérifie son contrat
/// contre le catalogue courant avant promotion atomique. Les actions à effet ne
/// sont volontairement jamais exécutées pendant ce test.
fn validate_workflow(wf: &Workflow) -> Result<serde_json::Value, String> {
    if wf.steps.is_empty() || wf.steps.len() > 30 { return Err("Nombre d'étapes invalide".into()); }
    let specs = Engine::with_builtins().specs();
    let mut ids = std::collections::BTreeSet::new();
    for step in &wf.steps {
        if step.id.trim().is_empty() || !ids.insert(step.id.clone()) { return Err(format!("Id d'étape invalide ou dupliqué : {}", step.id)); }
        let spec = specs.iter().find(|s| s.id == step.action).ok_or_else(|| format!("Action inconnue : {}", step.action))?;
        for required in spec.params.iter().filter(|p| p.required) {
            if !step.params.contains_key(&required.key) { return Err(format!("{} : paramètre requis {} manquant", step.id, required.key)); }
        }
    }
    Ok(serde_json::json!({"status":"passed","checks":["json_roundtrip","known_actions","required_params","unique_step_ids"],"steps":wf.steps.len()}))
}

fn promote_candidate(app: &tauri::AppHandle, wf: &Workflow) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let root = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    let candidates = root.join("skill_candidates");
    fs::create_dir_all(&candidates).map_err(|e| e.to_string())?;
    let candidate = candidates.join(format!("{}-v{}.json", crate::fluxo_slug(&wf.name), wf.version.max(1)));
    fs::write(&candidate, wf.to_json().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let reloaded = fs::read_to_string(&candidate).map_err(|e| e.to_string())?;
    let parsed = Workflow::from_json(&reloaded).map_err(|e| format!("Canary JSON : {e}"))?;
    let report = validate_workflow(&parsed)?;
    write_workflow(app, &parsed)?;
    let health_dir = root.join("skill_health");
    fs::create_dir_all(&health_dir).map_err(|e| e.to_string())?;
    fs::write(health_dir.join(format!("{}.json", crate::fluxo_slug(&wf.name))), serde_json::to_string_pretty(&serde_json::json!({"version":wf.version.max(1),"promotion":"canary_passed","validation":report,"consecutive_failures":0})).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(report)
}

/// Observe les exécutions réelles d'une version promue.
///
/// Deux filets, pas un seul :
///  - **trois échecs consécutifs** → retour arrière immédiat (panne franche) ;
///  - **taux de succès inférieur à la version précédente** sur un nombre
///    d'exécutions suffisant → retour arrière aussi. C'est ce second filet qui
///    manquait : une version simplement moins bonne, mais qui n'échoue jamais
///    trois fois d'affilée, restait en place indéfiniment.
///
/// Les compteurs par version sont aussi ce qui rend l'optimiseur honnête : le
/// score du juge ne fait que proposer, ces chiffres-là tranchent.
pub fn record_skill_result(app: &tauri::AppHandle, name: &str, success: bool) {
    use tauri::Manager;
    static HEALTH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let Ok(_guard) = HEALTH_LOCK.lock() else { return; };
    let Ok(root) = crate::paths::shared_data_dir(app.path()) else { return; };
    let dir = root.join("skill_health");
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(format!("{}.json", crate::fluxo_slug(name)));
    let mut state = fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).unwrap_or_else(|| serde_json::json!({"version":0,"consecutive_failures":0}));
    let current = crate::fluxo_find_file(app, name).map(|(_,w)| w.version.max(1)).unwrap_or(0);

    // Compteurs de la version en cours d'exécution.
    let key = current.to_string();
    let mut entry = state["versions"][&key].clone();
    if !entry.is_object() { entry = serde_json::json!({"runs":0,"ok":0}); }
    entry["runs"] = serde_json::json!(entry["runs"].as_u64().unwrap_or(0) + 1);
    if success { entry["ok"] = serde_json::json!(entry["ok"].as_u64().unwrap_or(0) + 1); }
    state["versions"][&key] = entry;

    let failures = if success { 0 } else { state["consecutive_failures"].as_u64().unwrap_or(0) + 1 };
    state["consecutive_failures"] = serde_json::json!(failures);
    state["last_result"] = serde_json::json!(if success {"success"} else {"failure"});

    let rate_of = |v: u32| -> Option<f64> {
        let e = state["versions"].get(v.to_string())?;
        let runs = e.get("runs")?.as_u64()?;
        if runs < MIN_RUNS_FOR_REGRESSION { return None; }
        Some(e.get("ok")?.as_u64()? as f64 / runs as f64)
    };
    let regressed = current > 1
        && match (rate_of(current), rate_of(current - 1)) {
            // Marge de 10 points : sans elle, un écart de bruit suffirait à
            // faire osciller la version active à chaque exécution.
            (Some(now), Some(before)) => now + 0.10 < before,
            _ => false,
        };

    if (failures >= 3 || regressed) && current > 1 {
        if skill_rollback(app.clone(), name.to_string(), current - 1).is_ok() {
            state["auto_rollback"] = serde_json::json!({
                "from": current,
                "to_source": current - 1,
                "reason": if regressed { "taux_inferieur" } else { "trois_echecs" },
            });
            state["consecutive_failures"] = serde_json::json!(0);
        }
    }
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, serde_json::to_string_pretty(&state).unwrap_or_default()).is_ok() { let _ = fs::rename(tmp, path); }
}

/// En dessous, un taux de succès n'est que du bruit.
const MIN_RUNS_FOR_REGRESSION: u64 = 5;

#[tauri::command]
pub fn skill_validate(app: tauri::AppHandle, name: String) -> Result<serde_json::Value, String> {
    let (_, wf) = crate::fluxo_find_file(&app, &name).ok_or_else(|| format!("Skill « {name} » introuvable"))?;
    validate_workflow(&wf)
}

// ===================== Création / amélioration =====================

/// Crée un skill (workflow Fluxo) depuis une spec simplifiée fournie par un
/// agent. Refuse d'écraser un workflow existant (→ passer par improve_skill).
pub fn create_skill(
    app: &tauri::AppHandle,
    author: &str,
    spec_json: &str,
) -> Result<String, String> {
    let spec: serde_json::Value = serde_json::from_str(strip_fences(spec_json))
        .map_err(|e| format!("spec JSON invalide : {e}"))?;
    let name = spec
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("champ `name` manquant")?;
    if crate::fluxo_find_file(app, name).is_some() {
        return Err(format!(
            "Le skill « {name} » existe déjà — utilise improve_skill pour le modifier."
        ));
    }
    let description = spec
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let steps = parse_steps(spec.get("steps").unwrap_or(&serde_json::Value::Null))?;
    let wf = Workflow {
        name: name.to_string(),
        steps,
        trigger: None,
        locked: false,
        available_as_tool: true,
        description: description.clone(),
        version: 1,
        created_by: author.to_string(),
    };
    let validation = promote_candidate(app, &wf)?;
    snapshot(app, &wf)?;
    crate::llmlog::log(
        app,
        crate::llmlog::LogEntry {
            kind: "skill".into(),
            source: author.to_string(),
            detail: format!("Création du skill « {name} » (v1) — {description}"),
            success: true,
            ..Default::default()
        },
    );
    Ok(format!(
        "Skill « {name} » créé (v1, {} étape(s), canary validé : {}). Il est maintenant disponible comme outil.",
        wf.steps.len(), validation["status"].as_str().unwrap_or("passed")
    ))
}

/// Améliore un skill existant : le LLM réécrit les étapes à partir du feedback
/// (erreur rencontrée, comportement souhaité). L'ancienne version est
/// photographiée, la nouvelle prend `version + 1`.
pub fn improve_skill(
    app: &tauri::AppHandle,
    author: &str,
    name: &str,
    feedback: &str,
) -> Result<String, String> {
    let (_, wf) =
        crate::fluxo_find_file(app, name).ok_or_else(|| format!("Skill « {name} » introuvable"))?;
    if wf.locked {
        return Err("Ce workflow est verrouillé (système) : non modifiable.".into());
    }
    let system = format!(
        "Tu améliores un skill : un workflow Fluxo, suite d'étapes exécutées en séquence. \
La sortie d'une étape est réutilisable via {{{{son_id}}}}, l'entrée du skill via {{{{input}}}}, \
la sortie précédente via {{{{last}}}}.\n\
Actions disponibles (id : description (params, * = requis)) :\n{}\n\
Réponds UNIQUEMENT avec un objet JSON de la forme \
{{\"description\": \"…\", \"steps\": [{{\"id\": \"s1\", \"action\": \"…\", \"params\": {{…}}}}]}} \
— sans texte autour, sans markdown. Les valeurs de params sont des chaînes/nombres/booléens simples.",
        actions_catalog()
    );
    let user = format!(
        "Skill « {} » (version {}) — description : {}\n\nÉtapes actuelles :\n{}\n\nAmélioration demandée / problème constaté :\n{}",
        wf.name,
        wf.version.max(1),
        if wf.description.is_empty() { "(aucune)" } else { &wf.description },
        serde_json::to_string_pretty(&steps_to_simple(&wf)).unwrap_or_default(),
        feedback
    );
    let raw = crate::agents::complete_llm(app, &system, &user)?;
    let mut new_wf = variant_from_response(&wf, &raw, author)?;

    // Photographie l'existant AVANT écrasement, puis écrit la nouvelle version.
    snapshot(app, &wf)?;
    new_wf.version = wf.version.max(1) + 1;
    let validation = promote_candidate(app, &new_wf).map_err(|e| format!("Candidat v{} rejeté, version active conservée : {e}", new_wf.version))?;
    snapshot(app, &new_wf)?;
    crate::llmlog::log(
        app,
        crate::llmlog::LogEntry {
            kind: "skill".into(),
            source: author.to_string(),
            detail: format!(
                "Amélioration du skill « {name} » (v{} → v{}) : {}",
                wf.version.max(1),
                new_wf.version,
                feedback
            ),
            success: true,
            ..Default::default()
        },
    );
    Ok(format!(
        "Skill « {name} » amélioré : v{} ({} étape(s), canary {}).",
        new_wf.version,
        new_wf.steps.len(),
        validation["status"].as_str().unwrap_or("passed")
    ))
}


// ===================== Variantes (optimiseur) =====================
// Ces trois fonctions découpent ce que `improve_skill` faisait d'un bloc :
// proposer, filtrer, promouvoir. L'optimiseur en a besoin séparément — il
// produit plusieurs candidats, n'en garde qu'un, et jette les autres.

/// Reconstruit un workflow depuis la réponse JSON du modèle, sans rien écrire.
fn variant_from_response(
    base: &Workflow,
    raw: &str,
    author: &str,
) -> Result<Workflow, String> {
    let parsed: serde_json::Value = serde_json::from_str(strip_fences(raw))
        .map_err(|e| format!("le modèle n'a pas renvoyé un JSON valide : {e}"))?;
    let steps = parse_steps(parsed.get("steps").unwrap_or(&serde_json::Value::Null))?;
    let mut wf = base.clone();
    wf.steps = steps;
    wf.created_by = author.to_string();
    if let Some(d) = parsed.get("description").and_then(|v| v.as_str()) {
        if !d.trim().is_empty() {
            wf.description = d.trim().to_string();
        }
    }
    Ok(wf)
}

/// Demande UNE variante d'un skill au modèle. Rien n'est écrit sur le disque :
/// c'est l'appelant qui décide, après notation, laquelle mérite d'exister.
pub fn propose_variant(
    app: &tauri::AppHandle,
    base: &Workflow,
    feedback: &str,
) -> Result<Workflow, String> {
    let system = format!(
        "Tu améliores un skill : un workflow Fluxo, suite d'étapes exécutées en séquence. \
La sortie d'une étape est réutilisable via {{{{son_id}}}}, l'entrée du skill via {{{{input}}}}, \
la sortie précédente via {{{{last}}}}.\n\
Actions disponibles (id : description (params, * = requis)) :\n{}\n\
Réponds UNIQUEMENT avec un objet JSON de la forme \
{{\"description\": \"…\", \"steps\": [{{\"id\": \"s1\", \"action\": \"…\", \"params\": {{…}}}}]}} \
— sans texte autour, sans markdown.",
        actions_catalog()
    );
    let user = format!(
        "Skill « {} » (version {}) — description : {}\n\nÉtapes actuelles :\n{}\n\n{}",
        base.name,
        base.version.max(1),
        if base.description.is_empty() { "(aucune)" } else { &base.description },
        serde_json::to_string_pretty(&steps_to_simple(base)).unwrap_or_default(),
        feedback
    );
    let raw = crate::agents::complete_llm(app, &system, &user)?;
    variant_from_response(base, &raw, "optimiseur")
}

/// Barrières franchies AVANT toute notation : contrat valide, taille contenue,
/// et surtout **aucune action inédite** par rapport à la version en place. Une
/// variante qui s'autoriserait un nouvel effet (réseau, suppression) ne serait
/// plus une optimisation mais un élargissement de pouvoir, et il n'a pas à
/// passer par une note de juge.
pub fn gate_candidate(candidate: &Workflow, base: &Workflow) -> Result<(), String> {
    validate_workflow(candidate)?;
    if candidate.steps.len() > base.steps.len().max(3) * 2 {
        return Err(format!(
            "Variante rejetée : {} étapes contre {} — trop d'écart.",
            candidate.steps.len(),
            base.steps.len()
        ));
    }
    let known: std::collections::BTreeSet<&str> =
        base.steps.iter().map(|s| s.action.as_str()).collect();
    let extra: Vec<&str> = candidate
        .steps
        .iter()
        .map(|s| s.action.as_str())
        .filter(|a| !known.contains(a))
        .collect();
    if !extra.is_empty() {
        return Err(format!(
            "Variante rejetée : actions inédites ({}). Une optimisation ne doit pas élargir les pouvoirs du skill.",
            extra.join(", ")
        ));
    }
    // `Step` n'implémente pas PartialEq (moteur vendorisé, à ne pas modifier) :
    // on compare la forme simplifiée, qui est de toute façon ce que le modèle
    // a produit.
    let same_steps = serde_json::to_string(&steps_to_simple(candidate)).ok()
        == serde_json::to_string(&steps_to_simple(base)).ok();
    if same_steps && candidate.description == base.description {
        return Err("Variante identique à la version en place.".into());
    }
    Ok(())
}

/// Promeut une variante retenue par l'optimiseur : photographie l'ancienne,
/// incrémente la version, repasse le canary, et note d'où elle vient.
pub fn promote_optimized(
    app: &tauri::AppHandle,
    mut candidate: Workflow,
    judge_score: f64,
) -> Result<u32, String> {
    let (_, current) = crate::fluxo_find_file(app, &candidate.name)
        .ok_or_else(|| format!("Skill « {} » introuvable", candidate.name))?;
    snapshot(app, &current)?;
    candidate.version = current.version.max(1) + 1;
    promote_candidate(app, &candidate)
        .map_err(|e| format!("Candidat v{} rejeté, version active conservée : {e}", candidate.version))?;
    snapshot(app, &candidate)?;
    mark_version_origin(app, &candidate.name, candidate.version, "optimiseur", judge_score);
    Ok(candidate.version)
}

/// Inscrit dans la fiche de santé d'où vient une version et quel score de juge
/// l'a fait promouvoir — sans quoi l'historique ne dirait pas *pourquoi*.
fn mark_version_origin(app: &tauri::AppHandle, name: &str, version: u32, origin: &str, score: f64) {
    use tauri::Manager;
    let Ok(root) = crate::paths::shared_data_dir(app.path()) else { return; };
    let path = root.join("skill_health").join(format!("{}.json", crate::fluxo_slug(name)));
    let mut state = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let entry = state["versions"][version.to_string()].clone();
    let mut entry = if entry.is_object() { entry } else { serde_json::json!({"runs":0,"ok":0}) };
    entry["origin"] = serde_json::json!(origin);
    if score >= 0.0 {
        entry["judge_score"] = serde_json::json!(score);
    }
    state["versions"][version.to_string()] = entry;
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, serde_json::to_string_pretty(&state).unwrap_or_default()).is_ok() {
        let _ = fs::rename(tmp, path);
    }
}

/// Retire d'éventuelles clôtures markdown (```json … ```) autour d'un JSON.
fn strip_fences(s: &str) -> &str {
    let t = s.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    t.strip_suffix("```").unwrap_or(t).trim()
}

// ===================== Commandes Tauri =====================

/// Métadonnées d'une version photographiée d'un skill.
#[derive(serde::Serialize)]
pub struct SkillVersion {
    pub version: u32,
    pub created_by: String,
    pub steps: usize,
    pub description: String,
}

/// Historique des versions d'un skill (croissant).
#[tauri::command]
pub fn skill_versions(app: tauri::AppHandle, name: String) -> Vec<SkillVersion> {
    let Ok(dir) = versions_dir(&app, &name) else {
        return Vec::new();
    };
    let mut out: Vec<SkillVersion> = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let txt = fs::read_to_string(e.path()).ok()?;
            let wf = Workflow::from_json(&txt).ok()?;
            Some(SkillVersion {
                version: wf.version.max(1),
                created_by: wf.created_by,
                steps: wf.steps.len(),
                description: wf.description,
            })
        })
        .collect();
    out.sort_by_key(|v| v.version);
    out.dedup_by_key(|v| v.version);
    out
}

/// Restaure une version antérieure d'un skill. La restauration devient une
/// nouvelle version (historique linéaire, pas de réécriture du passé).
#[tauri::command]
pub fn skill_rollback(app: tauri::AppHandle, name: String, version: u32) -> Result<String, String> {
    let dir = versions_dir(&app, &name)?;
    let txt = fs::read_to_string(dir.join(format!("v{version}.json")))
        .map_err(|_| format!("Version v{version} introuvable pour « {name} »"))?;
    let old = Workflow::from_json(&txt).map_err(|e| e.to_string())?;
    let current = crate::fluxo_find_file(&app, &name)
        .map(|(_, wf)| wf.version.max(1))
        .unwrap_or(0);
    let mut restored = old;
    restored.version = current + 1;
    restored.created_by = format!("rollback v{version}");
    write_workflow(&app, &restored)?;
    snapshot(&app, &restored)?;
    crate::llmlog::log(
        &app,
        crate::llmlog::LogEntry {
            kind: "skill".into(),
            source: "user".into(),
            detail: format!(
                "Rollback du skill « {name} » vers v{version} (devient v{})",
                restored.version
            ),
            success: true,
            ..Default::default()
        },
    );
    Ok(format!(
        "« {name} » restauré depuis v{version} (nouvelle version v{}).",
        restored.version
    ))
}

/// Amélioration d'un skill lancée depuis l'UI (async : appel LLM bloquant).
#[tauri::command]
pub async fn skill_improve(
    app: tauri::AppHandle,
    name: String,
    feedback: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || improve_skill(&app, "user", &name, &feedback))
        .await
        .map_err(|e| format!("Tâche interrompue : {e}"))?
}

#[cfg(test)]
mod gate_tests {
    use super::*;
    use fluxo_engine::Step;
    use std::collections::BTreeMap;

    /// Fabrique un workflow valide : les paramètres requis de chaque action sont
    /// remplis depuis le catalogue du moteur, sinon c'est `validate_workflow`
    /// qui échouerait et on ne testerait plus les barrières visées.
    fn wf(steps: Vec<(&str, &str)>) -> Workflow {
        let specs = Engine::with_builtins().specs();
        Workflow {
            name: "test".into(),
            steps: steps
                .into_iter()
                .map(|(id, action)| {
                    let mut params = BTreeMap::new();
                    if let Some(spec) = specs.iter().find(|s| s.id == action) {
                        for required in spec.params.iter().filter(|p| p.required) {
                            params.insert(required.key.clone(), FluxoValue::Text("x".into()));
                        }
                    }
                    Step { id: id.into(), action: action.into(), params, name: None }
                })
                .collect(),
            trigger: None,
            locked: false,
            available_as_tool: true,
            description: "d".into(),
            version: 1,
            created_by: "test".into(),
        }
    }

    #[test]
    fn refuse_les_actions_inedites() {
        // Une « optimisation » qui s'autorise une action absente de la version en
        // place élargirait les pouvoirs du skill : c'est un refus, pas une note.
        let base = wf(vec![("s1", "ollama_generate")]);
        let candidate = wf(vec![("s1", "ollama_generate"), ("s2", "http_request")]);
        let err = gate_candidate(&candidate, &base).unwrap_err();
        assert!(err.contains("http_request"), "message inattendu : {err}");
    }

    #[test]
    fn refuse_une_copie_conforme() {
        let base = wf(vec![("s1", "ollama_generate")]);
        assert!(gate_candidate(&base.clone(), &base).is_err());
    }

    #[test]
    fn refuse_une_variante_demesuree() {
        let base = wf(vec![("s1", "ollama_generate")]);
        let big: Vec<(&str, &str)> = vec![
            ("a", "ollama_generate"), ("b", "ollama_generate"), ("c", "ollama_generate"),
            ("d", "ollama_generate"), ("e", "ollama_generate"), ("f", "ollama_generate"),
            ("g", "ollama_generate"),
        ];
        let err = gate_candidate(&wf(big), &base).unwrap_err();
        assert!(err.contains("étapes"), "message inattendu : {err}");
    }

    #[test]
    fn accepte_une_vraie_variante() {
        let base = wf(vec![("s1", "ollama_generate")]);
        let candidate = wf(vec![("s1", "ollama_generate"), ("s2", "ollama_generate")]);
        assert!(gate_candidate(&candidate, &base).is_ok());
    }
}
