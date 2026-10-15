//! Auto-amélioration **mesurée** des agents.
//!
//! La forge de skills (`skills.rs`) permettait déjà à un agent de réécrire ses
//! outils, et `agents.rs` distille ses leçons — mais rien ne disait si une
//! réécriture était une amélioration. « Trois échecs consécutifs » est une
//! alarme de régression, pas une mesure : une version simplement moins bonne,
//! qui n'échoue jamais franchement, restait en place indéfiniment.
//!
//! Ce module ajoute les trois pièces manquantes :
//!
//! 1. **Un corpus de rejeu** (`eval_corpus.json`) construit depuis l'activité
//!    réelle des agents : chaque tâche passée devient un cas avec son verdict.
//!    Sans ensemble de cas fixe, « meilleur » n'est pas mesurable.
//! 2. **Une recherche de variantes** : on demande au modèle N réécritures d'un
//!    skill (ou d'une instruction) en lui montrant les cas ÉCHOUÉS — mutation
//!    réflexive —, puis on les note et on ne promeut que si le score dépasse
//!    strictement la référence.
//! 3. **Un score par version** : chaque version accumule ses exécutions réelles
//!    (`runs`/`ok`), ce qui permet un retour arrière sur *taux de succès* et
//!    plus seulement sur échecs consécutifs.
//!
//! **Honnêteté de la mesure.** Les candidats ne sont PAS exécutés : un skill
//! peut écrire des fichiers, appeler le réseau ou piloter du matériel, et
//! rejouer ça pour départager deux variantes serait dangereux. Le score de
//! sélection est donc rendu par un juge LLM lisant les cas réels (proxy), et il
//! ne décide que de la promotion. Le juge de vérité, lui, reste la production :
//! les compteurs par version accumulent les vrais verdicts et déclenchent le
//! retour arrière. Le proxy propose, la production dispose.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// Nombre de cas soumis au juge par candidat. Au-delà, le contexte des petits
/// modèles locaux explose sans que la note gagne en fiabilité.
const MAX_JUDGE_CASES: usize = 8;
/// Plafond du corpus : au-delà, on garde les cas les plus récents.
const MAX_CASES: usize = 400;

// ===================== Corpus de rejeu =====================

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct EvalCase {
    pub id: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub agent_name: String,
    /// "task" (compte rendu d'une tâche) ou "skill" (appel d'un skill).
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub skill: String,
    /// Énoncé : la tâche, ou l'entrée passée au skill.
    #[serde(default)]
    pub input: String,
    /// Ce qui a été produit à l'époque — sert de référence au juge.
    #[serde(default)]
    pub observed: String,
    #[serde(default)]
    pub criteria: Vec<String>,
    /// Verdict d'origine : le cas a-t-il réussi ?
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub ts: u64,
    /// "trace" (extrait de l'activité) ou "manual" (ajouté à la main).
    #[serde(default)]
    pub source: String,
}

fn corpus_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("eval_corpus.json"))
}

fn read_corpus(app: &tauri::AppHandle) -> Vec<EvalCase> {
    corpus_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_corpus(app: &tauri::AppHandle, list: &[EvalCase]) -> Result<(), String> {
    let path = corpus_path(app)?;
    let keep = if list.len() > MAX_CASES {
        &list[list.len() - MAX_CASES..]
    } else {
        list
    };
    let tmp = path.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_string_pretty(keep).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

/// Construit (ou complète) le corpus depuis l'activité réelle des agents.
/// Idempotent : un cas déjà présent (même agent, même horodatage, même énoncé)
/// n'est pas dupliqué, on peut donc relancer la construction à volonté.
#[tauri::command]
pub fn eval_corpus_build(app: tauri::AppHandle, agent_id: String) -> Result<serde_json::Value, String> {
    let activity = crate::agents::activity_snapshot(&app);
    let agents = crate::agents::agents_snapshot(&app);
    let mut corpus = read_corpus(&app);
    let known: std::collections::HashSet<String> = corpus.iter().map(|c| c.id.clone()).collect();
    let mut added = 0usize;

    for (aid, entries) in activity {
        if !agent_id.is_empty() && aid != agent_id {
            continue;
        }
        let name = agents
            .iter()
            .find(|a| a.id == aid)
            .map(|a| a.name.clone())
            .unwrap_or_default();
        for entry in entries {
            let (kind, input, observed) = match entry.kind.as_str() {
                "report" => ("task", entry.task.clone(), entry.output.clone()),
                "step" => ("skill", entry.input.clone(), entry.result.clone()),
                _ => continue,
            };
            if input.trim().is_empty() {
                continue;
            }
            let id = format!("{aid}-{}-{}", entry.ts, kind);
            if known.contains(&id) {
                continue;
            }
            corpus.push(EvalCase {
                id,
                agent_id: aid.clone(),
                agent_name: name.clone(),
                kind: kind.into(),
                skill: entry.skill.clone(),
                input: truncate(&input, 600),
                observed: truncate(&observed, 900),
                criteria: Vec::new(),
                success: entry.success,
                ts: entry.ts,
                source: "trace".into(),
            });
            added += 1;
        }
    }
    corpus.sort_by_key(|c| c.ts);
    let total = corpus.len();
    write_corpus(&app, &corpus)?;
    Ok(serde_json::json!({ "added": added, "total": total }))
}

#[tauri::command]
pub fn eval_corpus_list(app: tauri::AppHandle, agent_id: String) -> Vec<EvalCase> {
    let mut list = read_corpus(&app);
    if !agent_id.is_empty() {
        list.retain(|c| c.agent_id == agent_id);
    }
    list.reverse(); // le plus récent d'abord, comme partout ailleurs dans l'UI
    list
}

/// Ajoute un cas écrit à la main : c'est ainsi qu'on donne à l'optimiseur une
/// cible qu'aucune exécution passée ne couvre encore.
#[tauri::command]
pub fn eval_case_add(
    app: tauri::AppHandle,
    agent_id: String,
    skill: String,
    input: String,
    expected: String,
    criteria: Vec<String>,
) -> Result<EvalCase, String> {
    if input.trim().is_empty() {
        return Err("Un cas doit avoir un énoncé.".into());
    }
    let agents = crate::agents::agents_snapshot(&app);
    let case = EvalCase {
        id: format!("manual-{}", now_secs()),
        agent_name: agents
            .iter()
            .find(|a| a.id == agent_id)
            .map(|a| a.name.clone())
            .unwrap_or_default(),
        agent_id,
        kind: if skill.trim().is_empty() { "task".into() } else { "skill".into() },
        skill,
        input: truncate(&input, 600),
        observed: truncate(&expected, 900),
        criteria,
        success: true, // un cas écrit à la main décrit le comportement ATTENDU
        ts: now_secs(),
        source: "manual".into(),
    };
    let mut corpus = read_corpus(&app);
    corpus.push(case.clone());
    write_corpus(&app, &corpus)?;
    Ok(case)
}

#[tauri::command]
pub fn eval_case_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut corpus = read_corpus(&app);
    corpus.retain(|c| c.id != id);
    write_corpus(&app, &corpus)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ===================== Juge =====================

/// Note un candidat sur un lot de cas. Un seul appel LLM par candidat : le juge
/// rend un verdict par cas, la note est la proportion de cas satisfaits.
///
/// Le juge ne voit jamais quelle variante est la référence ni son score : on
/// évite qu'il « confirme » simplement la version en place.
fn judge(
    app: &tauri::AppHandle,
    what: &str,
    candidate: &str,
    cases: &[EvalCase],
) -> Result<(f64, Vec<serde_json::Value>), String> {
    if cases.is_empty() {
        return Err("Aucun cas d'évaluation : construis d'abord le corpus.".into());
    }
    let payload: Vec<serde_json::Value> = cases
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "enonce": c.input,
                "resultat_observe": c.observed,
                "criteres": c.criteria,
                "avait_reussi": c.success,
            })
        })
        .collect();
    let system = format!(
        "Tu es un évaluateur indépendant. On te donne {what} candidat et des cas réels déjà rencontrés. \
Pour CHAQUE cas, juge si ce candidat aurait produit un résultat satisfaisant — en te fondant sur les critères \
quand ils existent, sinon sur le résultat observé. Sois sévère : un candidat qui ne traite pas le cas est un échec. \
Réponds UNIQUEMENT en JSON : {{\"verdicts\":[{{\"id\":\"…\",\"ok\":true|false,\"raison\":\"…\"}}]}}."
    );
    let user = format!(
        "Candidat :\n{candidate}\n\nCas à évaluer :\n{}",
        serde_json::to_string_pretty(&payload).unwrap_or_default()
    );
    let raw = crate::agents::complete_llm(app, &system, &user)?;
    let clean = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed: serde_json::Value =
        serde_json::from_str(clean).map_err(|e| format!("Réponse du juge illisible : {e}"))?;
    let verdicts = parsed
        .get("verdicts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if verdicts.is_empty() {
        return Err("Le juge n'a rendu aucun verdict.".into());
    }
    let ok = verdicts
        .iter()
        .filter(|v| v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false))
        .count();
    Ok((ok as f64 / verdicts.len() as f64, verdicts))
}

// ===================== Score par version de skill =====================

fn health_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let root = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    let dir = root.join("skill_health");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{}.json", crate::fluxo_slug(name))))
}

/// État de santé d'un skill, versions comprises. Alimenté par
/// `skills::record_skill_result` à chaque exécution réelle.
#[tauri::command]
pub fn skill_score(app: tauri::AppHandle, name: String) -> serde_json::Value {
    let state = health_path(&app, &name)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let current = crate::fluxo_find_file(&app, &name)
        .map(|(_, w)| w.version.max(1))
        .unwrap_or(0);
    let mut versions: Vec<serde_json::Value> = state
        .get("versions")
        .and_then(|v| v.as_object())
        .map(|map| {
            map.iter()
                .map(|(v, s)| {
                    let runs = s.get("runs").and_then(|x| x.as_u64()).unwrap_or(0);
                    let ok = s.get("ok").and_then(|x| x.as_u64()).unwrap_or(0);
                    serde_json::json!({
                        "version": v.parse::<u32>().unwrap_or(0),
                        "runs": runs,
                        "ok": ok,
                        "rate": if runs > 0 { ok as f64 / runs as f64 } else { -1.0 },
                        "judge_score": s.get("judge_score").cloned().unwrap_or(serde_json::Value::Null),
                        "origin": s.get("origin").cloned().unwrap_or(serde_json::Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    versions.sort_by_key(|v| v["version"].as_u64().unwrap_or(0));
    serde_json::json!({
        "name": name,
        "current": current,
        "consecutive_failures": state.get("consecutive_failures").cloned().unwrap_or(serde_json::json!(0)),
        "last_result": state.get("last_result").cloned().unwrap_or(serde_json::Value::Null),
        "auto_rollback": state.get("auto_rollback").cloned().unwrap_or(serde_json::Value::Null),
        "versions": versions,
    })
}

// ===================== Optimisation d'un skill =====================

fn cases_for_skill(corpus: &[EvalCase], skill: &str) -> Vec<EvalCase> {
    let mut cases: Vec<EvalCase> = corpus
        .iter()
        .filter(|c| c.skill.eq_ignore_ascii_case(skill))
        .cloned()
        .collect();
    // Les échecs d'abord : ce sont eux qui portent l'information utile à une
    // mutation, un corpus de réussites ne dit pas quoi corriger.
    cases.sort_by_key(|c| (c.success, std::cmp::Reverse(c.ts)));
    cases.truncate(MAX_JUDGE_CASES);
    cases
}

fn steps_digest(wf: &fluxo_engine::Workflow) -> String {
    wf.steps
        .iter()
        .map(|s| {
            format!(
                "- {} : {} ({})",
                s.id,
                s.action,
                s.params
                    .iter()
                    .map(|(k, v)| format!("{k}={}", truncate(&format!("{v:?}"), 60)))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Cycle complet : variantes → barrières → notation → promotion conditionnelle.
///
/// Ne promeut QUE si la meilleure variante dépasse strictement la référence.
/// À égalité, on garde l'existant : une réécriture qui n'apporte rien coûte un
/// numéro de version, une invalidation des statistiques et un risque, pour rien.
#[tauri::command]
pub async fn skill_optimize(
    app: tauri::AppHandle,
    name: String,
    variants: u32,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || optimize_skill_blocking(&app, &name, variants.clamp(1, 5)))
        .await
        .map_err(|e| e.to_string())?
}

fn optimize_skill_blocking(
    app: &tauri::AppHandle,
    name: &str,
    variants: u32,
) -> Result<serde_json::Value, String> {
    let (_, current) =
        crate::fluxo_find_file(app, name).ok_or_else(|| format!("Skill « {name} » introuvable"))?;
    if current.locked {
        return Err("Ce workflow est verrouillé (système) : non modifiable.".into());
    }
    let corpus = read_corpus(app);
    let cases = cases_for_skill(&corpus, name);
    if cases.is_empty() {
        return Err(format!(
            "Aucun cas d'évaluation pour « {name} ». Construis le corpus après quelques exécutions, ou ajoute un cas à la main."
        ));
    }

    // Référence : le skill en place, noté sur les mêmes cas et par le même juge.
    let baseline_repr = format!(
        "Description : {}\nÉtapes :\n{}",
        current.description,
        steps_digest(&current)
    );
    let (baseline_score, _) = judge(app, "un skill (workflow d'étapes)", &baseline_repr, &cases)?;

    let failures: Vec<String> = cases
        .iter()
        .filter(|c| !c.success)
        .map(|c| format!("- entrée : {}\n  résultat : {}", c.input, c.observed))
        .collect();

    let mut results = Vec::new();
    let mut best: Option<(f64, fluxo_engine::Workflow)> = None;

    for i in 0..variants {
        let feedback = format!(
            "Voici {} cas d'échec observés en production :\n{}\n\n\
Propose une VARIANTE {} du skill qui traiterait ces cas. Change réellement quelque chose \
(ordre des étapes, paramètres, étape ajoutée ou retirée) — une copie de l'existant est inutile.",
            failures.len(),
            if failures.is_empty() {
                "(aucun échec enregistré : cherche plutôt à simplifier ou fiabiliser)".to_string()
            } else {
                failures.join("\n")
            },
            i + 1
        );
        let candidate = match crate::skills::propose_variant(app, &current, &feedback) {
            Ok(wf) => wf,
            Err(e) => {
                results.push(serde_json::json!({ "variant": i + 1, "rejected": e }));
                continue;
            }
        };
        // Barrières AVANT notation : inutile de payer un juge pour un candidat
        // qui ne passerait pas la promotion.
        if let Err(e) = crate::skills::gate_candidate(&candidate, &current) {
            results.push(serde_json::json!({ "variant": i + 1, "rejected": e }));
            continue;
        }
        let repr = format!(
            "Description : {}\nÉtapes :\n{}",
            candidate.description,
            steps_digest(&candidate)
        );
        match judge(app, "un skill (workflow d'étapes)", &repr, &cases) {
            Ok((score, verdicts)) => {
                results.push(serde_json::json!({
                    "variant": i + 1,
                    "score": score,
                    "steps": candidate.steps.len(),
                    "verdicts": verdicts,
                }));
                if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                    best = Some((score, candidate));
                }
            }
            Err(e) => results.push(serde_json::json!({ "variant": i + 1, "rejected": e })),
        }
    }

    let mut promoted = serde_json::Value::Null;
    if let Some((score, candidate)) = best {
        if score > baseline_score {
            let version = crate::skills::promote_optimized(app, candidate, score)?;
            promoted = serde_json::json!({ "version": version, "score": score });
            crate::llmlog::log(
                app,
                crate::llmlog::LogEntry {
                    kind: "skill".into(),
                    source: "optimiseur".into(),
                    detail: format!(
                        "« {name} » promu en v{version} — score juge {:.0} % contre {:.0} % ({} cas)",
                        score * 100.0,
                        baseline_score * 100.0,
                        cases.len()
                    ),
                    success: true,
                    ..Default::default()
                },
            );
        }
    }

    Ok(serde_json::json!({
        "skill": name,
        "cases": cases.len(),
        "baseline": baseline_score,
        "variants": results,
        "promoted": promoted,
    }))
}

// ===================== Optimisation de l'instruction =====================

fn instruction_dir(app: &tauri::AppHandle, agent_id: &str) -> Result<PathBuf, String> {
    let root = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    let dir = root.join("instruction_versions").join(agent_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct InstructionVersion {
    pub version: u32,
    pub ts: u64,
    pub instruction: String,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub origin: String,
}

fn read_instruction_versions(app: &tauri::AppHandle, agent_id: &str) -> Vec<InstructionVersion> {
    let Ok(dir) = instruction_dir(app, agent_id) else {
        return Vec::new();
    };
    let mut out: Vec<InstructionVersion> = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok())
        .collect();
    out.sort_by_key(|v| v.version);
    out
}

#[tauri::command]
pub fn agent_instruction_versions(app: tauri::AppHandle, agent_id: String) -> Vec<InstructionVersion> {
    read_instruction_versions(&app, &agent_id)
}

fn save_instruction_version(
    app: &tauri::AppHandle,
    agent_id: &str,
    instruction: &str,
    score: f64,
    origin: &str,
) -> Result<u32, String> {
    let dir = instruction_dir(app, agent_id)?;
    let version = read_instruction_versions(app, agent_id)
        .last()
        .map(|v| v.version + 1)
        .unwrap_or(1);
    let entry = InstructionVersion {
        version,
        ts: now_secs(),
        instruction: instruction.to_string(),
        score,
        origin: origin.to_string(),
    };
    fs::write(
        dir.join(format!("v{version}.json")),
        serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(version)
}

/// Restaure une instruction précédente. L'instruction courante est d'abord
/// photographiée : un retour arrière ne doit jamais être un aller simple.
#[tauri::command]
pub fn agent_instruction_rollback(
    app: tauri::AppHandle,
    agent_id: String,
    version: u32,
) -> Result<String, String> {
    let target = read_instruction_versions(&app, &agent_id)
        .into_iter()
        .find(|v| v.version == version)
        .ok_or_else(|| format!("Version v{version} introuvable"))?;
    let current = crate::agents::agent_instruction(&app, &agent_id)?;
    save_instruction_version(&app, &agent_id, &current, -1.0, "avant-retour")?;
    crate::agents::set_agent_instruction(&app, &agent_id, &target.instruction)?;
    Ok(format!("Instruction restaurée depuis la v{version}."))
}

/// Même cycle que pour un skill, appliqué au prompt système de l'agent : c'est
/// la seule partie de sa politique qu'il ne pouvait pas faire évoluer.
#[tauri::command]
pub async fn agent_instruction_optimize(
    app: tauri::AppHandle,
    agent_id: String,
    variants: u32,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        optimize_instruction_blocking(&app, &agent_id, variants.clamp(1, 5))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn optimize_instruction_blocking(
    app: &tauri::AppHandle,
    agent_id: &str,
    variants: u32,
) -> Result<serde_json::Value, String> {
    let current = crate::agents::agent_instruction(app, agent_id)?;
    if current.trim().is_empty() {
        return Err("Cet agent n'a pas encore d'instruction à optimiser.".into());
    }
    let corpus = read_corpus(app);
    let mut cases: Vec<EvalCase> = corpus
        .into_iter()
        .filter(|c| c.agent_id == agent_id && c.kind == "task")
        .collect();
    cases.sort_by_key(|c| (c.success, std::cmp::Reverse(c.ts)));
    cases.truncate(MAX_JUDGE_CASES);
    if cases.is_empty() {
        return Err("Aucun cas d'évaluation pour cet agent : construis d'abord le corpus.".into());
    }

    let (baseline_score, _) = judge(app, "une instruction d'agent (prompt système)", &current, &cases)?;
    let failures: Vec<String> = cases
        .iter()
        .filter(|c| !c.success)
        .map(|c| format!("- tâche : {}\n  résultat : {}", c.input, c.observed))
        .collect();

    let mut results = Vec::new();
    let mut best: Option<(f64, String)> = None;

    for i in 0..variants {
        let system = "Tu réécris l'instruction (prompt système) d'un agent autonome. \
Garde son rôle et ses contraintes, mais rends-la plus précise et plus opérante sur les cas fournis. \
Réponds UNIQUEMENT avec le texte de l'instruction, sans guillemets, sans préambule, sans markdown. \
Reste sous 1200 caractères.";
        let user = format!(
            "Instruction actuelle :\n{current}\n\nCas d'échec observés :\n{}\n\nÉcris la variante {} — elle doit différer réellement de l'actuelle.",
            if failures.is_empty() {
                "(aucun échec : cherche à réduire les ambiguïtés)".to_string()
            } else {
                failures.join("\n")
            },
            i + 1
        );
        let candidate = match crate::agents::complete_llm(app, system, &user) {
            Ok(text) => text.trim().to_string(),
            Err(e) => {
                results.push(serde_json::json!({ "variant": i + 1, "rejected": e }));
                continue;
            }
        };
        // Barrières : ni vide, ni démesurée, ni identique à l'actuelle.
        if candidate.is_empty() || candidate.chars().count() > 2000 || candidate == current {
            results.push(serde_json::json!({ "variant": i + 1, "rejected": "Variante vide, trop longue ou identique." }));
            continue;
        }
        match judge(app, "une instruction d'agent (prompt système)", &candidate, &cases) {
            Ok((score, verdicts)) => {
                results.push(serde_json::json!({
                    "variant": i + 1,
                    "score": score,
                    "instruction": candidate,
                    "verdicts": verdicts,
                }));
                if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                    best = Some((score, candidate));
                }
            }
            Err(e) => results.push(serde_json::json!({ "variant": i + 1, "rejected": e })),
        }
    }

    let mut promoted = serde_json::Value::Null;
    if let Some((score, candidate)) = best {
        if score > baseline_score {
            // L'ancienne d'abord : sans elle, le retour arrière n'aurait pas de cible.
            save_instruction_version(app, agent_id, &current, baseline_score, "précédente")?;
            let version = save_instruction_version(app, agent_id, &candidate, score, "optimiseur")?;
            crate::agents::set_agent_instruction(app, agent_id, &candidate)?;
            promoted = serde_json::json!({ "version": version, "score": score, "instruction": candidate });
            crate::llmlog::log(
                app,
                crate::llmlog::LogEntry {
                    kind: "skill".into(),
                    source: "optimiseur".into(),
                    detail: format!(
                        "Instruction de l'agent {agent_id} promue en v{version} — score juge {:.0} % contre {:.0} %",
                        score * 100.0,
                        baseline_score * 100.0
                    ),
                    success: true,
                    ..Default::default()
                },
            );
        }
    }

    Ok(serde_json::json!({
        "agent_id": agent_id,
        "cases": cases.len(),
        "baseline": baseline_score,
        "variants": results,
        "promoted": promoted,
    }))
}

// ===================== Tableau de bord =====================

/// Vue d'ensemble pour l'app Agents : taille du corpus, santé des skills,
/// versions d'instruction. Une seule commande, pour éviter que l'UI n'enchaîne
/// dix appels à chaque ouverture d'onglet.
#[tauri::command]
pub fn evolution_overview(app: tauri::AppHandle, agent_id: String) -> serde_json::Value {
    let corpus = read_corpus(&app);
    let mine: Vec<&EvalCase> = corpus.iter().filter(|c| c.agent_id == agent_id).collect();
    let ok = mine.iter().filter(|c| c.success).count();
    let agents = crate::agents::agents_snapshot(&app);
    let skills = agents
        .iter()
        .find(|a| a.id == agent_id)
        .map(|a| a.skills.clone())
        .unwrap_or_default();
    let skill_scores: Vec<serde_json::Value> = skills
        .iter()
        .map(|s| skill_score(app.clone(), s.clone()))
        .collect();
    let instructions = read_instruction_versions(&app, &agent_id);
    serde_json::json!({
        "corpus_total": corpus.len(),
        "corpus_agent": mine.len(),
        "corpus_success": ok,
        "corpus_failed": mine.len() - ok,
        "skills": skill_scores,
        "instruction_versions": instructions.len(),
        "instruction_last_score": instructions.last().map(|v| v.score).unwrap_or(-1.0),
    })
}
