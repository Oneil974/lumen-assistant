//! Blocs de contrôle de flux — l'équivalent des blocs « Si / Répéter / Répéter
//! pour chaque » d'Apple Shortcuts. Ils ne sont pas des [`Action`] classiques :
//! l'exécuteur ([`crate::engine`]) les interprète spécialement (sauts, boucles).
//!
//! Le workflow reste une **liste plate** de pas avec des marqueurs d'ouverture
//! et de fermeture (comme le stockage interne de Shortcuts), ce qui simplifie
//! la sérialisation et le drag-drop.

use crate::action::{ActionSpec, ParamKind, ParamSpec};
use crate::value::Value;
use std::collections::BTreeMap;

/// Identifiants des pas de contrôle reconnus par l'exécuteur.
pub const IF: &str = "if";
pub const ELSE: &str = "else";
pub const ENDIF: &str = "endif";
pub const REPEAT: &str = "repeat";
pub const ENDREPEAT: &str = "endrepeat";
pub const REPEAT_EACH: &str = "repeat_each";
pub const ENDREPEAT_EACH: &str = "endrepeat_each";
pub const STOP: &str = "stop";

/// Vrai si l'id correspond à un pas géré directement par l'exécuteur.
pub fn is_control(id: &str) -> bool {
    matches!(
        id,
        IF | ELSE | ENDIF | REPEAT | ENDREPEAT | REPEAT_EACH | ENDREPEAT_EACH | STOP
    )
}

/// Vrai si l'id ouvre un bloc (augmente l'indentation).
pub fn is_opener(id: &str) -> bool {
    matches!(id, IF | REPEAT | REPEAT_EACH)
}

/// Schémas exposés à l'UI pour la catégorie « Contrôle ». Seuls les *ouvreurs*
/// (et `stop`) apparaissent dans la bibliothèque ; les marqueurs de fermeture
/// sont insérés automatiquement par l'UI et n'ont pas de schéma.
pub fn control_specs() -> Vec<ActionSpec> {
    vec![
        ActionSpec {
            id: IF.into(),
            name: "Si".into(),
            description: "Exécute des actions selon une condition (avec Sinon).".into(),
            category: "Contrôle".into(),
            icon: "git-branch".into(),
            params: vec![
                ParamSpec::new("input", "Entrée", ParamKind::Text).placeholder("{{input}}"),
                ParamSpec::new(
                    "condition",
                    "Condition",
                    ParamKind::Select {
                        options: vec![
                            "égal à".into(),
                            "différent de".into(),
                            "contient".into(),
                            "ne contient pas".into(),
                            "supérieur à".into(),
                            "inférieur à".into(),
                            "est vide".into(),
                            "n'est pas vide".into(),
                        ],
                    },
                ),
                ParamSpec::new("value", "Valeur", ParamKind::Text),
            ],
            produces_output: false,
        },
        ActionSpec {
            id: REPEAT.into(),
            name: "Répéter".into(),
            description: "Répète les actions un nombre de fois donné.".into(),
            category: "Contrôle".into(),
            icon: "repeat".into(),
            params: vec![ParamSpec::new("count", "Nombre de fois", ParamKind::Number).required()],
            produces_output: false,
        },
        ActionSpec {
            id: REPEAT_EACH.into(),
            name: "Répéter pour chaque".into(),
            description: "Répète les actions pour chaque élément d'une liste (variable {{item}}).".into(),
            category: "Contrôle".into(),
            icon: "layers".into(),
            params: vec![ParamSpec::new("list", "Liste", ParamKind::Text).placeholder("{{input}}")],
            produces_output: false,
        },
        ActionSpec {
            id: STOP.into(),
            name: "Arrêter".into(),
            description: "Interrompt l'exécution du workflow.".into(),
            category: "Contrôle".into(),
            icon: "stop-circle".into(),
            params: vec![],
            produces_output: false,
        },
    ]
}

/// Spec du bloc « Exécuter un workflow » (sous-workflow). Géré spécialement par
/// l'exécuteur (il a besoin du résolveur de workflows).
pub fn subworkflow_spec() -> ActionSpec {
    ActionSpec {
        id: "run_workflow".into(),
        name: "Exécuter un workflow".into(),
        description: "Lance un autre workflow Fluxo (sous-workflow) avec l'entrée courante."
            .into(),
        category: "Contrôle".into(),
        icon: "layers".into(),
        params: vec![ParamSpec::new("workflow", "Nom du workflow", ParamKind::Text)
            .required()
            .placeholder("Nom exact d'un autre workflow")],
        produces_output: true,
    }
}

/// Opérateurs de condition du bloc « Si ».
pub fn eval_condition(params: &BTreeMap<String, Value>) -> bool {
    let input = params.get("input").cloned().unwrap_or(Value::Null);
    let cond = params
        .get("condition")
        .map(|v| v.as_text())
        .unwrap_or_else(|| "égal à".into());
    let value = params.get("value").cloned().unwrap_or(Value::Null);

    let l = input.as_text();
    let r = value.as_text();

    match cond.as_str() {
        "est vide" => l.is_empty(),
        "n'est pas vide" => !l.is_empty(),
        "contient" => l.contains(&r),
        "ne contient pas" => !l.contains(&r),
        "supérieur à" => match (input.as_number(), value.as_number()) {
            (Some(a), Some(b)) => a > b,
            _ => l > r,
        },
        "inférieur à" => match (input.as_number(), value.as_number()) {
            (Some(a), Some(b)) => a < b,
            _ => l < r,
        },
        "différent de" => l != r,
        _ => l == r, // « égal à »
    }
}
