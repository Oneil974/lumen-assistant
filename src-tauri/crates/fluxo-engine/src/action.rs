//! Le contrat des actions : un schéma (exposé à l'UI pour générer la
//! bibliothèque et les éditeurs de paramètres) + une implémentation.

use crate::value::Value;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Type d'un paramètre — pilote le widget affiché dans l'éditeur de l'UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ParamKind {
    Text,
    Multiline,
    /// Éditeur visuel 8x8 : sérialisé comme texte JSON de 64 pixels
    /// (`null` ou couleur `#rrggbb`), pour rester compatible avec les workflows.
    Matrix8,
    Number,
    Bool,
    /// Liste d'options fermée (menu déroulant).
    Select { options: Vec<String> },
}

/// Description d'un paramètre d'action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamSpec {
    pub key: String,
    pub label: String,
    #[serde(flatten)]
    pub kind: ParamKind,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub default: Option<Value>,
}

impl ParamSpec {
    pub fn new(key: &str, label: &str, kind: ParamKind) -> Self {
        Self {
            key: key.to_string(),
            label: label.to_string(),
            kind,
            required: false,
            placeholder: None,
            default: None,
        }
    }
    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }
    pub fn placeholder(mut self, p: &str) -> Self {
        self.placeholder = Some(p.to_string());
        self
    }
}

/// Schéma complet d'une action, sérialisé tel quel vers l'UI (`list_actions`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionSpec {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    /// Glyphe/emoji pour la bibliothèque (l'UI peut le remplacer par une icône).
    pub icon: String,
    pub params: Vec<ParamSpec>,
    /// Indique si l'action produit une sortie réutilisable comme variable.
    pub produces_output: bool,
}

/// Contexte d'exécution partagé entre les étapes d'un workflow.
pub struct ExecContext {
    /// Entrée initiale du workflow (la prompt). Figée au démarrage et exposée
    /// via `{{input}}` — ne doit jamais être réécrite par les étapes.
    pub initial: Value,
    /// Sortie de l'étape précédente (la « variable magique » implicite),
    /// exposée via `{{last}}` / `{{previous}}`. Réécrite à chaque étape.
    pub input: Value,
    /// Sorties nommées des étapes déjà exécutées (clé = id d'étape).
    pub vars: BTreeMap<String, Value>,
    /// Racine de sandbox active, le cas échéant. Quand elle est définie, les
    /// actions fichiers qui ont l'option « confiner à la sandbox » résolvent leurs
    /// chemins **relativement** à cette racine, sans pouvoir en sortir. Posée par
    /// l'hôte (Lumen) quand un agent exécute ses skills dans sa sandbox.
    pub sandbox_root: Option<std::path::PathBuf>,
}

impl ExecContext {
    pub fn new() -> Self {
        Self {
            initial: Value::Null,
            input: Value::Null,
            vars: BTreeMap::new(),
            sandbox_root: None,
        }
    }
}

impl Default for ExecContext {
    fn default() -> Self {
        Self::new()
    }
}

/// Résout `rel` **confiné** sous `root` : n'accepte que des composants normaux
/// (rejette chemin absolu et `..`) puis vérifie via canonicalisation de l'ancêtre
/// existant qu'aucun symlink ne fait sortir de la racine. Même garantie que la
/// sandbox côté hôte. Renvoie une erreur si le chemin tente de sortir.
pub fn confine_path(
    root: &std::path::Path,
    rel: &str,
) -> Result<std::path::PathBuf, String> {
    use std::path::Component;
    let mut out = root.to_path_buf();
    for comp in std::path::Path::new(rel).components() {
        match comp {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return Err("Chemin hors sandbox".into()),
        }
    }
    let root_canon = root.canonicalize().map_err(|e| e.to_string())?;
    let mut anc: &std::path::Path = &out;
    let existing = loop {
        if anc.exists() {
            break anc.canonicalize().map_err(|e| e.to_string())?;
        }
        match anc.parent() {
            Some(p) => anc = p,
            None => return Err("Chemin hors sandbox".into()),
        }
    };
    if !existing.starts_with(&root_canon) {
        return Err("Chemin hors sandbox".into());
    }
    Ok(out)
}

/// Une action exécutable. Object-safe → stockée comme `Arc<dyn Action>`.
pub trait Action: Send + Sync {
    fn spec(&self) -> ActionSpec;
    fn run(
        &self,
        params: &BTreeMap<String, Value>,
        ctx: &mut ExecContext,
    ) -> anyhow::Result<Value>;
}

/// Helpers de lecture des paramètres (déjà interpolés par l'exécuteur).
pub fn param_text(params: &BTreeMap<String, Value>, key: &str) -> String {
    params.get(key).map(|v| v.as_text()).unwrap_or_default()
}

pub fn param_num(params: &BTreeMap<String, Value>, key: &str) -> f64 {
    params.get(key).and_then(|v| v.as_number()).unwrap_or(0.0)
}

pub fn param_value(params: &BTreeMap<String, Value>, key: &str) -> Value {
    params.get(key).cloned().unwrap_or(Value::Null)
}
