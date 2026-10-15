//! Le type de donnée qui circule entre les étapes d'un workflow — l'équivalent
//! des « variables magiques » d'Apple Shortcuts.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// Une valeur typée échangée entre actions. Sérialisable pour le stockage des
/// workflows et le passage vers l'UI / la CLI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Value {
    Null,
    Text(String),
    Number(f64),
    Bool(bool),
    List(Vec<Value>),
    Dict(BTreeMap<String, Value>),
    /// Chemin de fichier (on ne transporte pas le contenu, juste la référence).
    File(String),
}

impl Value {
    /// Représentation textuelle, utilisée pour l'interpolation `{{var}}` et
    /// l'affichage. Les structures composites passent par leur forme JSON.
    pub fn as_text(&self) -> String {
        match self {
            Value::Null => String::new(),
            Value::Text(s) => s.clone(),
            Value::Number(n) => {
                if n.fract() == 0.0 {
                    format!("{}", *n as i64)
                } else {
                    n.to_string()
                }
            }
            Value::Bool(b) => b.to_string(),
            Value::File(p) => p.clone(),
            Value::List(_) | Value::Dict(_) => {
                serde_json::to_string(self).unwrap_or_default()
            }
        }
    }

    /// Coercition numérique (pour les calculs et conditions).
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            Value::Text(s) => s.trim().replace(',', ".").parse().ok(),
            _ => None,
        }
    }

    /// Coercition en liste : une List telle quelle, un texte JSON de tableau
    /// décodé, sinon la valeur seule dans une liste à un élément.
    pub fn as_list(&self) -> Vec<Value> {
        match self {
            Value::List(l) => l.clone(),
            Value::Text(s) => {
                if let Ok(serde_json::Value::Array(arr)) =
                    serde_json::from_str::<serde_json::Value>(s)
                {
                    arr.iter().map(json_to_value).collect()
                } else {
                    vec![self.clone()]
                }
            }
            Value::Null => vec![],
            other => vec![other.clone()],
        }
    }

    /// Coercition en dictionnaire : un Dict tel quel, un texte JSON d'objet
    /// décodé, sinon un dictionnaire vide. Symétrique de [`as_list`](Self::as_list).
    pub fn as_dict(&self) -> BTreeMap<String, Value> {
        match self {
            Value::Dict(d) => d.clone(),
            Value::Text(s) => {
                if let Ok(serde_json::Value::Object(o)) =
                    serde_json::from_str::<serde_json::Value>(s)
                {
                    o.iter().map(|(k, v)| (k.clone(), json_to_value(v))).collect()
                } else {
                    BTreeMap::new()
                }
            }
            _ => BTreeMap::new(),
        }
    }

    /// Sémantique « vrai/faux » pour les conditions.
    pub fn is_truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Text(s) => !s.is_empty(),
            Value::Number(n) => *n != 0.0,
            Value::Bool(b) => *b,
            Value::List(l) => !l.is_empty(),
            Value::Dict(d) => !d.is_empty(),
            Value::File(p) => !p.is_empty(),
        }
    }
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_text())
    }
}

/// Convertit une valeur `serde_json` en [`Value`] Fluxo.
pub fn json_to_value(j: &serde_json::Value) -> Value {
    match j {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Bool(*b),
        serde_json::Value::Number(n) => Value::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => Value::Text(s.clone()),
        serde_json::Value::Array(a) => Value::List(a.iter().map(json_to_value).collect()),
        serde_json::Value::Object(o) => {
            Value::Dict(o.iter().map(|(k, v)| (k.clone(), json_to_value(v))).collect())
        }
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::Text(s.to_string())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::Text(s)
    }
}
