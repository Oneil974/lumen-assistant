//! Fluxo — moteur d'automatisation headless.
//!
//! Architecture : un [`Workflow`] est une suite d'[`Step`](workflow::Step), chacune
//! invoquant une [`Action`] paramétrée. L'[`Engine`] exécute le workflow en
//! passant une [`Value`] d'étape en étape (les « variables magiques »).
//!
//! Ce crate ne dépend ni de Tauri ni d'aucune UI : il est réutilisable par la
//! CLI, l'app designer et, à terme, Lumen comme backend d'actions.

pub mod action;
pub mod actions;
pub mod control;
pub mod engine;
pub mod lumen;
pub mod value;
pub mod workflow;

pub use action::{Action, ActionSpec, ExecContext, ParamKind, ParamSpec};
pub use engine::Engine;
pub use value::Value;

/// Clé de l'API cloud configurée dans l'hôte (Lumen), fournie à la demande.
/// Elle ne transite JAMAIS par l'environnement du processus : un script lancé
/// par un workflow (`run_script`) en hériterait et pourrait la divulguer.
static API_KEY_PROVIDER: std::sync::OnceLock<fn() -> String> = std::sync::OnceLock::new();

/// Enregistre la fonction qui lit la clé API de l'hôte (appelée au démarrage).
pub fn set_api_key_provider(f: fn() -> String) {
    let _ = API_KEY_PROVIDER.set(f);
}

/// Dossiers que les blocs de fichiers en « chemin libre » ne peuvent ni lire,
/// ni écrire, ni lister : la configuration de l'hôte (clés API scellées,
/// jetons, comptes). Posés par l'hôte au démarrage.
static PROTECTED_DIRS: std::sync::OnceLock<Vec<std::path::PathBuf>> = std::sync::OnceLock::new();

pub fn set_protected_dirs(dirs: Vec<std::path::PathBuf>) {
    let canon = dirs.into_iter().map(|d| std::fs::canonicalize(&d).unwrap_or(d)).collect();
    let _ = PROTECTED_DIRS.set(canon);
}

/// Chemin résolu au plus près du disque (liens symboliques suivis sur la partie
/// existante), pour qu'un `..` ou un lien ne contourne pas la protection.
fn resolved(path: &std::path::Path) -> std::path::PathBuf {
    let abs = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut existing = abs.clone();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent()) {
            (Some(n), Some(p)) => { rest.push(n); existing = p.to_path_buf(); }
            _ => break,
        }
    }
    let mut out = std::fs::canonicalize(&existing).unwrap_or(existing);
    for part in rest.into_iter().rev() {
        if part == ".." { out.pop(); } else if part != "." { out.push(part); }
    }
    out
}

/// Vrai si `path` tombe dans un dossier protégé de l'hôte.
pub fn is_protected_path(path: &std::path::Path) -> bool {
    let Some(dirs) = PROTECTED_DIRS.get() else { return false };
    let p = resolved(path);
    dirs.iter().any(|d| p.starts_with(d))
}

/// Clé API de l'hôte, ou vide.
pub fn host_api_key() -> String {
    API_KEY_PROVIDER.get().map(|f| f()).unwrap_or_default()
}
pub use workflow::{RunResult, Step, StepLog, Trigger, Workflow};

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn step(id: &str, action: &str, params: &[(&str, &str)]) -> Step {
        let mut map = BTreeMap::new();
        for (k, v) in params {
            map.insert(k.to_string(), Value::Text(v.to_string()));
        }
        Step {
            id: id.to_string(),
            action: action.to_string(),
            params: map,
            name: None,
        }
    }

    #[test]
    fn builtins_are_registered() {
        let engine = Engine::with_builtins();
        let ids: Vec<_> = engine.specs().into_iter().map(|s| s.id).collect();
        for expected in ["text", "set_variable", "notification", "http_get", "run_script"] {
            assert!(ids.contains(&expected.to_string()), "manque {expected}");
        }
    }

    #[test]
    fn runs_linear_workflow_with_variable_passing() {
        let engine = Engine::with_builtins();
        let wf = Workflow {
            name: "demo".into(),
            steps: vec![
                step("a", "text", &[("text", "monde")]),
                step("b", "text", &[("text", "bonjour {{a}}")]),
            ],
            trigger: None,
            locked: false,
        };
        let res = engine.run(&wf);
        assert!(res.success, "exécution échouée : {:?}", res.steps);
        assert_eq!(res.output, Value::Text("bonjour monde".into()));
    }

    #[test]
    fn last_token_references_previous_step() {
        let engine = Engine::with_builtins();
        let wf = Workflow {
            name: "demo".into(),
            steps: vec![
                step("a", "text", &[("text", "42")]),
                step("b", "text", &[("text", "valeur={{last}}")]),
            ],
            trigger: None,
            locked: false,
        };
        let res = engine.run(&wf);
        assert_eq!(res.output, Value::Text("valeur=42".into()));
    }

    #[test]
    fn input_token_keeps_initial_prompt_across_steps() {
        let engine = Engine::with_builtins();
        // `{{input}}` doit rester la prompt d'origine même après une étape
        // dont la sortie diffère (ici "ignore-moi"), et ne pas être écrasée.
        let wf = Workflow {
            name: "demo".into(),
            steps: vec![
                step("a", "text", &[("text", "ignore-moi")]),
                step("b", "text", &[("text", "prompt={{input}}")]),
            ],
            trigger: None,
            locked: false,
        };
        let res = engine.run_with_input(&wf, Value::Text("bonjour".into()));
        assert_eq!(res.output, Value::Text("prompt=bonjour".into()));
    }

    #[test]
    fn unknown_action_fails_gracefully() {
        let engine = Engine::with_builtins();
        let wf = Workflow {
            name: "demo".into(),
            steps: vec![step("a", "n_existe_pas", &[])],
            trigger: None,
            locked: false,
        };
        let res = engine.run(&wf);
        assert!(!res.success);
        assert!(res.steps[0].error.is_some());
    }

    fn marker(id: &str, action: &str) -> Step {
        Step { id: id.into(), action: action.into(), params: BTreeMap::new(), name: None }
    }

    #[test]
    fn if_block_takes_true_branch() {
        let engine = Engine::with_builtins();
        let mut if_params = BTreeMap::new();
        if_params.insert("input".into(), Value::Text("oui".into()));
        if_params.insert("condition".into(), Value::Text("égal à".into()));
        if_params.insert("value".into(), Value::Text("oui".into()));
        let wf = Workflow {
            name: "if".into(),
            steps: vec![
                Step { id: "i".into(), action: "if".into(), params: if_params, name: None },
                step("t", "text", &[("text", "VRAI")]),
                marker("e", "else"),
                step("f", "text", &[("text", "FAUX")]),
                marker("end", "endif"),
            ],
            trigger: None,
            locked: false,
        };
        let res = engine.run(&wf);
        assert!(res.success);
        assert_eq!(res.output, Value::Text("VRAI".into()));
    }

    #[test]
    fn repeat_runs_n_times() {
        let engine = Engine::with_builtins();
        let mut rp = BTreeMap::new();
        rp.insert("count".into(), Value::Number(3.0));
        let wf = Workflow {
            name: "rep".into(),
            steps: vec![
                Step { id: "r".into(), action: "repeat".into(), params: rp, name: None },
                step("body", "text", &[("text", "x{{index}}")]),
                marker("end", "endrepeat"),
            ],
            trigger: None,
            locked: false,
        };
        let res = engine.run(&wf);
        assert!(res.success);
        // dernière itération : index = 3
        assert_eq!(res.output, Value::Text("x3".into()));
    }

    #[test]
    fn calculate_action_works() {
        let engine = Engine::with_builtins();
        let wf = Workflow {
            name: "calc".into(),
            steps: vec![step("c", "calculate", &[("expression", "(2 + 3) * 4")])],
            trigger: None,
            locked: false,
        };
        let res = engine.run(&wf);
        assert_eq!(res.output, Value::Number(20.0));
    }

    #[test]
    fn control_specs_present_in_library() {
        let engine = Engine::with_builtins();
        let ids: Vec<_> = engine.specs().into_iter().map(|s| s.id).collect();
        for c in ["if", "repeat", "repeat_each", "stop"] {
            assert!(ids.contains(&c.to_string()), "manque le bloc {c}");
        }
    }

    #[test]
    fn workflow_json_roundtrip() {
        let wf = Workflow {
            name: "demo".into(),
            steps: vec![step("a", "text", &[("text", "x")])],
            trigger: None,
            locked: false,
        };
        let json = wf.to_json().unwrap();
        let back = Workflow::from_json(&json).unwrap();
        assert_eq!(back.steps.len(), 1);
        assert_eq!(back.name, "demo");
    }
}
