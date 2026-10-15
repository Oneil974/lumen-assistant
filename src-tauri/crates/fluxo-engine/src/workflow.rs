//! Le format d'un workflow — l'équivalent d'un fichier `.shortcut`, sérialisé
//! en JSON (lisible, diffable, échangeable).

use crate::value::Value;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Une étape = une action paramétrée, avec un id stable servant à référencer
/// sa sortie comme variable (`{{step_id}}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    pub action: String,
    #[serde(default)]
    pub params: BTreeMap<String, Value>,
    /// Libellé personnalisé optionnel affiché dans le canvas.
    #[serde(default)]
    pub name: Option<String>,
}

/// Déclencheur d'un workflow — quand l'exécuter automatiquement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Trigger {
    /// Lancé uniquement à la main (par défaut).
    Manual,
    /// Expression CRON (6 champs : `sec min h jour mois jour-sem`).
    Cron { expr: String },
    /// Toutes les N secondes.
    Interval { seconds: u64 },
    /// À chaque modification d'un fichier ou dossier.
    FileChange { path: String },
    /// Sur réception d'une requête HTTP locale (POST {path}). Le corps de la
    /// requête devient l'entrée du workflow.
    Webhook { path: String },
    /// Quand un badge est posé sur le lecteur RFID du Lumen Controller.
    ///
    /// `uid` vide = **n'importe quel badge** ; sinon seul ce badge déclenche.
    /// Dans les deux cas l'UID lu devient l'entrée du workflow (`{{input}}`),
    /// ce qui permet à un workflow unique d'aiguiller lui-même selon le badge.
    Rfid {
        #[serde(default)]
        uid: String,
    },
}

impl Default for Trigger {
    fn default() -> Self {
        Trigger::Manual
    }
}

/// Un workflow nommé : une suite ordonnée d'étapes + un déclencheur.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub name: String,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub trigger: Option<Trigger>,
    /// Workflow « système » verrouillé (fourni par Fluxo, non supprimable/éditable
    /// dans l'UI). Ex. les équivalents des raccourcis Apple requis par Lumen.
    #[serde(default)]
    pub locked: bool,
    /// Exposé au function calling : le workflow est proposé comme **outil** au
    /// modèle (skill d'agent, routeur). Désactiver allège la liste d'outils et
    /// améliore la précision d'appel. Par défaut `true` (rétrocompatibilité :
    /// les workflows existants sans ce champ restent disponibles).
    #[serde(default = "default_true")]
    pub available_as_tool: bool,
    /// Description courte du workflow — injectée dans la description de l'outil
    /// au function calling (aide le modèle à choisir le bon skill).
    #[serde(default)]
    pub description: String,
    /// Numéro de version (skills auto-améliorés par les agents). 0 = workflow
    /// jamais versionné (créé à la main dans le designer).
    #[serde(default)]
    pub version: u32,
    /// Auteur de la version courante ("user", ou nom/id de l'agent créateur).
    #[serde(default)]
    pub created_by: String,
}

fn default_true() -> bool {
    true
}

impl Workflow {
    pub fn from_json(s: &str) -> anyhow::Result<Self> {
        Ok(serde_json::from_str(s)?)
    }
    pub fn to_json(&self) -> anyhow::Result<String> {
        Ok(serde_json::to_string_pretty(self)?)
    }
}

/// Journal d'exécution d'une étape (renvoyé à l'UI / la CLI).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepLog {
    pub step: String,
    pub action: String,
    pub output: Value,
    pub error: Option<String>,
}

/// Résultat global d'une exécution de workflow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub success: bool,
    pub steps: Vec<StepLog>,
    /// Sortie finale (dernière étape réussie).
    pub output: Value,
}
