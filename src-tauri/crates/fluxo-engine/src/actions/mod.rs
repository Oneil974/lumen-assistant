//! Bibliothèque d'actions intégrées, couvrant les grandes catégories d'Apple
//! Shortcuts (Texte, Nombres, Listes, Web, Système, Fichiers, Scripts…).
//! Toutes cross-platform. Le contrôle de flux (Si/Répéter) est géré à part dans
//! [`crate::control`] + [`crate::engine`].
//!
//! Chaque action est une [`FnAction`] (schéma + closure) pour limiter le
//! boilerplate ; les `icon` sont des **noms** d'icônes rendus en SVG par l'UI.

use crate::action::{
    param_num, param_text, param_value, Action, ActionSpec, ExecContext, ParamKind, ParamSpec,
};
use crate::engine::Engine;

mod lumen_apps;
use crate::value::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock, TryLockError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type RunFn = dyn Fn(&BTreeMap<String, Value>, &mut ExecContext) -> anyhow::Result<Value>
    + Send
    + Sync;

/// Action définie par un schéma + une closure d'exécution.
pub struct FnAction {
    spec: ActionSpec,
    run: Box<RunFn>,
}

impl Action for FnAction {
    fn spec(&self) -> ActionSpec {
        self.spec.clone()
    }
    fn run(
        &self,
        params: &BTreeMap<String, Value>,
        ctx: &mut ExecContext,
    ) -> anyhow::Result<Value> {
        (self.run)(params, ctx)
    }
}

fn spec(
    id: &str,
    name: &str,
    description: &str,
    category: &str,
    icon: &str,
    params: Vec<ParamSpec>,
    produces_output: bool,
) -> ActionSpec {
    ActionSpec {
        id: id.into(),
        name: name.into(),
        description: description.into(),
        category: category.into(),
        icon: icon.into(),
        params,
        produces_output,
    }
}

fn p(key: &str, label: &str, kind: ParamKind) -> ParamSpec {
    ParamSpec::new(key, label, kind)
}

fn select(options: &[&str]) -> ParamKind {
    ParamKind::Select {
        options: options.iter().map(|s| s.to_string()).collect(),
    }
}

/// Tente d'interpréter un texte comme du JSON (nombre, booléen, objet, tableau…)
/// pour que les valeurs saisies dans les actions Listes/JSON portent le bon type.
/// Un texte qui n'est pas du JSON valide reste un texte. Les valeurs déjà typées
/// (non-texte) sont rendues telles quelles.
fn loose(v: Value) -> Value {
    if let Value::Text(ref s) = v {
        let t = s.trim();
        if !t.is_empty() {
            if let Ok(j) = serde_json::from_str::<serde_json::Value>(t) {
                return crate::value::json_to_value(&j);
            }
        }
    }
    v
}

macro_rules! reg {
    ($engine:expr, $spec:expr, $run:expr) => {
        $engine.register(Arc::new(FnAction {
            spec: $spec,
            run: Box::new($run),
        }))
    };
}

pub fn register_builtins(e: &mut Engine) {
    // ===================== TEXTE =====================
    reg!(
        e,
        spec("text", "Texte", "Fournit un texte (avec variables {{…}}).", "Texte", "type",
            vec![p("text", "Texte", ParamKind::Multiline).placeholder("Texte ou {{input}}")], true),
        |params, _ctx| Ok(Value::Text(param_text(params, "text")))
    );
    reg!(
        e,
        spec("combine_text", "Combiner le texte", "Concatène deux textes avec un séparateur.", "Texte", "plus-square",
            vec![
                p("a", "Premier", ParamKind::Text).placeholder("{{input}}"),
                p("b", "Second", ParamKind::Text),
                p("separator", "Séparateur", ParamKind::Text),
            ], true),
        |params, _ctx| {
            let sep = param_text(params, "separator");
            Ok(Value::Text(format!("{}{}{}", param_text(params, "a"), sep, param_text(params, "b"))))
        }
    );
    reg!(
        e,
        spec("replace_text", "Remplacer le texte", "Remplace toutes les occurrences d'un motif.", "Texte", "edit-3",
            vec![
                p("text", "Texte", ParamKind::Multiline).placeholder("{{input}}"),
                p("find", "Rechercher", ParamKind::Text).required(),
                p("replace", "Remplacer par", ParamKind::Text),
            ], true),
        |params, _ctx| {
            let text = param_text(params, "text");
            let find = param_text(params, "find");
            let rep = param_text(params, "replace");
            Ok(Value::Text(if find.is_empty() { text } else { text.replace(&find, &rep) }))
        }
    );
    reg!(
        e,
        spec("split_text", "Diviser le texte", "Découpe un texte en liste selon un séparateur.", "Texte", "scissors",
            vec![
                p("text", "Texte", ParamKind::Multiline).placeholder("{{input}}"),
                p("separator", "Séparateur", ParamKind::Text).placeholder("\\n, virgule, espace…"),
            ], true),
        |params, _ctx| {
            let text = param_text(params, "text");
            let mut sep = param_text(params, "separator");
            if sep == "\\n" { sep = "\n".into(); }
            if sep.is_empty() { sep = "\n".into(); }
            Ok(Value::List(text.split(&sep).map(|s| Value::Text(s.to_string())).collect()))
        }
    );
    reg!(
        e,
        spec("change_case", "Changer la casse", "Met le texte en majuscules, minuscules ou capitalise.", "Texte", "type",
            vec![
                p("text", "Texte", ParamKind::Text).placeholder("{{input}}"),
                p("mode", "Casse", select(&["MAJUSCULES", "minuscules", "Capitaliser"])),
            ], true),
        |params, _ctx| {
            let text = param_text(params, "text");
            let out = match param_text(params, "mode").as_str() {
                "minuscules" => text.to_lowercase(),
                "Capitaliser" => text.split_whitespace()
                    .map(|w| {
                        let mut c = w.chars();
                        match c.next() {
                            Some(f) => f.to_uppercase().chain(c).collect::<String>(),
                            None => String::new(),
                        }
                    })
                    .collect::<Vec<_>>().join(" "),
                _ => text.to_uppercase(),
            };
            Ok(Value::Text(out))
        }
    );
    reg!(
        e,
        spec("url_encode", "Encoder pour URL", "Encode le texte en pourcent (percent-encoding).", "Texte", "link",
            vec![p("text", "Texte", ParamKind::Text).placeholder("{{input}}")], true),
        |params, _ctx| Ok(Value::Text(percent_encode(&param_text(params, "text"))))
    );
    reg!(
        e,
        spec("json_escape", "Échapper en JSON", "Transforme un texte en chaîne JSON valide (guillemets inclus). Utile pour bâtir un corps de requête.", "Texte", "code",
            vec![p("text", "Texte", ParamKind::Multiline).placeholder("{{input}}")], true),
        |params, _ctx| {
            // serde_json produit une chaîne JSON entre guillemets, échappements compris.
            let escaped = serde_json::to_string(&param_text(params, "text"))
                .unwrap_or_else(|_| "\"\"".to_string());
            Ok(Value::Text(escaped))
        }
    );

    // ===================== NOMBRES =====================
    reg!(
        e,
        spec("number", "Nombre", "Fournit une valeur numérique.", "Nombres", "hash",
            vec![p("value", "Valeur", ParamKind::Number)], true),
        |params, _ctx| Ok(Value::Number(param_num(params, "value")))
    );
    reg!(
        e,
        spec("calculate", "Calculer", "Évalue une expression arithmétique (+ - * / % et parenthèses).", "Nombres", "divide",
            vec![p("expression", "Expression", ParamKind::Text).required().placeholder("(2 + {{input}}) * 3")], true),
        |params, _ctx| {
            let expr = param_text(params, "expression");
            let n = eval_math(&expr).map_err(|e| anyhow::anyhow!("Expression invalide : {e}"))?;
            Ok(Value::Number(n))
        }
    );
    reg!(
        e,
        spec("random_number", "Nombre aléatoire", "Tire un entier entre min et max (inclus).", "Nombres", "shuffle",
            vec![
                p("min", "Min", ParamKind::Number),
                p("max", "Max", ParamKind::Number),
            ], true),
        |params, _ctx| {
            use rand::Rng;
            let (mut lo, mut hi) = (param_num(params, "min") as i64, param_num(params, "max") as i64);
            if lo > hi { std::mem::swap(&mut lo, &mut hi); }
            let n = rand::thread_rng().gen_range(lo..=hi);
            Ok(Value::Number(n as f64))
        }
    );
    reg!(
        e,
        spec("round", "Arrondir", "Arrondit un nombre.", "Nombres", "disc",
            vec![
                p("number", "Nombre", ParamKind::Number).placeholder("{{input}}"),
                p("mode", "Mode", select(&["au plus proche", "plancher", "plafond"])),
            ], true),
        |params, _ctx| {
            let n = param_num(params, "number");
            let out = match param_text(params, "mode").as_str() {
                "plancher" => n.floor(),
                "plafond" => n.ceil(),
                _ => n.round(),
            };
            Ok(Value::Number(out))
        }
    );

    // ===================== LISTES & JSON =====================
    reg!(
        e,
        spec("make_list", "Créer une liste", "Crée une liste à partir de lignes de texte.", "Listes", "list",
            vec![p("items", "Éléments (une ligne chacun)", ParamKind::Multiline)], true),
        |params, _ctx| {
            let items = param_text(params, "items");
            Ok(Value::List(items.lines().filter(|l| !l.trim().is_empty())
                .map(|l| Value::Text(l.to_string())).collect()))
        }
    );
    reg!(
        e,
        spec("count", "Compter", "Nombre d'éléments d'une liste, ou de caractères d'un texte.", "Listes", "hash",
            vec![p("input", "Entrée", ParamKind::Text).placeholder("{{input}}")], true),
        |params, _ctx| {
            let v = param_value(params, "input");
            let n = match &v {
                Value::List(l) => l.len(),
                other => other.as_text().chars().count(),
            };
            Ok(Value::Number(n as f64))
        }
    );
    reg!(
        e,
        spec("get_list_item", "Élément d'une liste", "Récupère le Nᵉ élément (1 = premier).", "Listes", "list",
            vec![
                p("list", "Liste", ParamKind::Text).placeholder("{{input}}"),
                p("index", "Position", ParamKind::Number),
            ], true),
        |params, _ctx| {
            let list = param_value(params, "list").as_list();
            let idx = param_num(params, "index") as i64;
            let i = if idx < 0 { list.len() as i64 + idx } else { idx - 1 };
            list.get(i.max(0) as usize).cloned()
                .ok_or_else(|| anyhow::anyhow!("Index hors limites"))
        }
    );
    reg!(
        e,
        spec("json_value", "Valeur depuis JSON", "Extrait une valeur d'un objet JSON par sa clé.", "Listes", "code",
            vec![
                p("json", "JSON", ParamKind::Multiline).placeholder("{{input}}"),
                p("key", "Clé", ParamKind::Text).required(),
            ], true),
        |params, _ctx| {
            let raw = param_text(params, "json");
            let key = param_text(params, "key");
            let parsed: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|e| anyhow::anyhow!("JSON invalide : {e}"))?;
            let got = parsed.get(&key)
                .ok_or_else(|| anyhow::anyhow!("Clé « {key} » absente"))?;
            Ok(crate::value::json_to_value(got))
        }
    );
    reg!(
        e,
        spec("list_append", "Ajouter à la liste", "Ajoute un élément à la fin d'une liste.", "Listes", "plus",
            vec![
                p("list", "Liste", ParamKind::Text).placeholder("{{input}}"),
                p("item", "Élément à ajouter", ParamKind::Text).required(),
            ], true),
        |params, _ctx| {
            let mut list = param_value(params, "list").as_list();
            list.push(loose(param_value(params, "item")));
            Ok(Value::List(list))
        }
    );
    reg!(
        e,
        spec("list_insert", "Insérer dans la liste", "Insère un élément à une position (1 = au début ; négatif = depuis la fin).", "Listes", "plus",
            vec![
                p("list", "Liste", ParamKind::Text).placeholder("{{input}}"),
                p("index", "Position", ParamKind::Number),
                p("item", "Élément à insérer", ParamKind::Text).required(),
            ], true),
        |params, _ctx| {
            let mut list = param_value(params, "list").as_list();
            let len = list.len() as i64;
            let idx = param_num(params, "index") as i64;
            let pos = (if idx < 0 { len + idx + 1 } else { idx - 1 }).clamp(0, len);
            list.insert(pos as usize, loose(param_value(params, "item")));
            Ok(Value::List(list))
        }
    );
    reg!(
        e,
        spec("list_set_item", "Modifier un élément", "Remplace le Nᵉ élément d'une liste (1 = premier ; négatif = depuis la fin).", "Listes", "save",
            vec![
                p("list", "Liste", ParamKind::Text).placeholder("{{input}}"),
                p("index", "Position", ParamKind::Number),
                p("value", "Nouvelle valeur", ParamKind::Text).required(),
            ], true),
        |params, _ctx| {
            let mut list = param_value(params, "list").as_list();
            let len = list.len() as i64;
            let idx = param_num(params, "index") as i64;
            let i = if idx < 0 { len + idx } else { idx - 1 };
            if i < 0 || i >= len {
                return Err(anyhow::anyhow!("Index hors limites"));
            }
            list[i as usize] = loose(param_value(params, "value"));
            Ok(Value::List(list))
        }
    );
    reg!(
        e,
        spec("list_remove_item", "Supprimer un élément", "Retire le Nᵉ élément d'une liste (1 = premier ; négatif = depuis la fin).", "Listes", "trash",
            vec![
                p("list", "Liste", ParamKind::Text).placeholder("{{input}}"),
                p("index", "Position", ParamKind::Number),
            ], true),
        |params, _ctx| {
            let mut list = param_value(params, "list").as_list();
            let len = list.len() as i64;
            let idx = param_num(params, "index") as i64;
            let i = if idx < 0 { len + idx } else { idx - 1 };
            if i < 0 || i >= len {
                return Err(anyhow::anyhow!("Index hors limites"));
            }
            list.remove(i as usize);
            Ok(Value::List(list))
        }
    );
    reg!(
        e,
        spec("list_contains", "La liste contient", "Vrai si la liste contient l'élément donné.", "Listes", "search",
            vec![
                p("list", "Liste", ParamKind::Text).placeholder("{{input}}"),
                p("item", "Élément", ParamKind::Text).required(),
            ], true),
        |params, _ctx| {
            let list = param_value(params, "list").as_list();
            let needle = loose(param_value(params, "item"));
            let needle_txt = needle.as_text();
            let found = list.iter().any(|v| *v == needle || v.as_text() == needle_txt);
            Ok(Value::Bool(found))
        }
    );
    reg!(
        e,
        spec("list_reverse", "Inverser la liste", "Renverse l'ordre des éléments d'une liste.", "Listes", "shuffle",
            vec![p("list", "Liste", ParamKind::Text).placeholder("{{input}}")], true),
        |params, _ctx| {
            let mut list = param_value(params, "list").as_list();
            list.reverse();
            Ok(Value::List(list))
        }
    );
    reg!(
        e,
        spec("join_list", "Joindre la liste", "Assemble les éléments d'une liste en un texte, séparés par le séparateur donné.", "Listes", "link",
            vec![
                p("list", "Liste", ParamKind::Text).placeholder("{{input}}"),
                p("separator", "Séparateur", ParamKind::Text).placeholder(", "),
            ], true),
        |params, _ctx| {
            let list = param_value(params, "list").as_list();
            let sep = param_text(params, "separator");
            let parts: Vec<String> = list.iter().map(|v| v.as_text()).collect();
            Ok(Value::Text(parts.join(&sep)))
        }
    );
    reg!(
        e,
        spec("dict_new", "Créer un dictionnaire", "Construit un objet JSON depuis des lignes « clé: valeur ».", "Listes", "code",
            vec![p("entries", "Entrées (une « clé: valeur » par ligne)", ParamKind::Multiline)
                .placeholder("nom: Alice\nâge: 30")], true),
        |params, _ctx| {
            let raw = param_text(params, "entries");
            let mut d = BTreeMap::new();
            for line in raw.lines() {
                let line = line.trim();
                if line.is_empty() { continue; }
                if let Some((k, v)) = line.split_once(':') {
                    d.insert(k.trim().to_string(), loose(Value::Text(v.trim().to_string())));
                }
            }
            Ok(Value::Dict(d))
        }
    );
    reg!(
        e,
        spec("dict_set", "Définir une valeur (JSON)", "Ajoute ou met à jour une clé dans un objet JSON.", "Listes", "plus",
            vec![
                p("dict", "Dictionnaire JSON", ParamKind::Multiline).placeholder("{{input}}"),
                p("key", "Clé", ParamKind::Text).required(),
                p("value", "Valeur", ParamKind::Text).required(),
            ], true),
        |params, _ctx| {
            let mut d = param_value(params, "dict").as_dict();
            d.insert(param_text(params, "key"), loose(param_value(params, "value")));
            Ok(Value::Dict(d))
        }
    );
    reg!(
        e,
        spec("dict_remove", "Supprimer une clé (JSON)", "Retire une clé d'un objet JSON.", "Listes", "trash",
            vec![
                p("dict", "Dictionnaire JSON", ParamKind::Multiline).placeholder("{{input}}"),
                p("key", "Clé à supprimer", ParamKind::Text).required(),
            ], true),
        |params, _ctx| {
            let mut d = param_value(params, "dict").as_dict();
            d.remove(&param_text(params, "key"));
            Ok(Value::Dict(d))
        }
    );
    reg!(
        e,
        spec("dict_keys", "Clés du dictionnaire", "Liste les clés d'un objet JSON.", "Listes", "list",
            vec![p("dict", "Dictionnaire JSON", ParamKind::Multiline).placeholder("{{input}}")], true),
        |params, _ctx| {
            let d = param_value(params, "dict").as_dict();
            Ok(Value::List(d.keys().map(|k| Value::Text(k.clone())).collect()))
        }
    );
    reg!(
        e,
        spec("dict_has", "Le dictionnaire a la clé", "Vrai si l'objet JSON contient la clé donnée.", "Listes", "search",
            vec![
                p("dict", "Dictionnaire JSON", ParamKind::Multiline).placeholder("{{input}}"),
                p("key", "Clé", ParamKind::Text).required(),
            ], true),
        |params, _ctx| {
            let d = param_value(params, "dict").as_dict();
            Ok(Value::Bool(d.contains_key(&param_text(params, "key"))))
        }
    );

    // ===================== VARIABLES =====================
    reg!(
        e,
        spec("set_variable", "Définir une variable", "Nomme une valeur réutilisable via {{nom}}.", "Variables", "tag",
            vec![
                p("name", "Nom", ParamKind::Text).required(),
                p("value", "Valeur", ParamKind::Text).placeholder("{{input}}"),
            ], true),
        |params, ctx| {
            let name = param_text(params, "name");
            let value = param_value(params, "value");
            if !name.is_empty() { ctx.vars.insert(name, value.clone()); }
            Ok(value)
        }
    );

    // ===================== WEB =====================
    reg!(
        e,
        spec("http_get", "Requête HTTP (GET)", "Récupère le contenu d'une URL.", "Web", "globe",
            vec![
                p("url", "URL", ParamKind::Text).required().placeholder("https://exemple.com/api"),
                p("headers", "Headers", ParamKind::Multiline).placeholder("Authorization: Bearer {{token}}\nAccept: application/json"),
            ], true),
        |params, _ctx| {
            let url = param_text(params, "url");
            if url.is_empty() { anyhow::bail!("URL vide"); }
            let client = reqwest::blocking::Client::new();
            let body = client.get(&url)
                .headers(parse_http_headers(&param_text(params, "headers"))?)
                .send()
                .and_then(|r| r.error_for_status()).and_then(|r| r.text())
                .map_err(|e| anyhow::anyhow!("Requête échouée : {e}"))?;
            Ok(Value::Text(body))
        }
    );
    reg!(
        e,
        spec("http_post", "Requête HTTP (POST)", "Envoie un corps à une URL et renvoie la réponse.", "Web", "upload-cloud",
            vec![
                p("url", "URL", ParamKind::Text).required(),
                p("headers", "Headers", ParamKind::Multiline).placeholder("Authorization: Bearer {{token}}\nContent-Type: application/json"),
                p("body", "Corps", ParamKind::Multiline).placeholder("{{input}}"),
            ], true),
        |params, _ctx| {
            let url = param_text(params, "url");
            if url.is_empty() { anyhow::bail!("URL vide"); }
            let client = reqwest::blocking::Client::new();
            let body = client.post(&url)
                .headers(parse_http_headers(&param_text(params, "headers"))?)
                .body(param_text(params, "body"))
                .send()
                .and_then(|r| r.error_for_status()).and_then(|r| r.text())
                .map_err(|e| anyhow::anyhow!("Requête échouée : {e}"))?;
            Ok(Value::Text(body))
        }
    );
    reg!(
        e,
        spec("mcp_tool", "Outil MCP", "Appelle un outil d'un connecteur MCP enregistré dans Lumen (Paramètres → Connecteurs). Le connecteur doit être activé.", "MCP", "plug",
            vec![
                p("server", "Connecteur", ParamKind::Text).required().placeholder("Fichiers"),
                p("tool", "Outil", ParamKind::Text).required().placeholder("read_file"),
                p("arguments", "Arguments JSON", ParamKind::Multiline).placeholder("{\n  \"path\": \"{{input}}\"\n}"),
            ], true),
        |params, _ctx| {
            let server = param_text(params, "server");
            let tool = param_text(params, "tool");
            if server.is_empty() || tool.is_empty() {
                anyhow::bail!("Indique le connecteur et l'outil MCP");
            }
            let args_raw = param_text(params, "arguments");
            let arguments = if args_raw.trim().is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str::<serde_json::Value>(&args_raw)
                    .map_err(|e| anyhow::anyhow!("Arguments JSON invalides : {e}"))?
            };
            // Passe par Lumen : c'est lui qui détient le registre, les secrets et
            // le contrôle d'activation du connecteur.
            let out = crate::lumen::post_json("/mcp/call", serde_json::json!({
                "server": server, "tool": tool, "arguments": arguments
            }))?;
            Ok(Value::Text(out))
        }
    );
    reg!(
        e,
        spec("mcp_list_tools", "Outils d'un connecteur MCP", "Liste les outils exposés par un connecteur MCP activé : pratique pour composer un workflow ou laisser le modèle choisir.", "MCP", "list",
            vec![p("server", "Connecteur", ParamKind::Text).required().placeholder("Fichiers")], true),
        |params, _ctx| {
            let server = param_text(params, "server");
            if server.is_empty() { anyhow::bail!("Connecteur MCP non indiqué"); }
            let out = crate::lumen::post_json("/mcp/tools", serde_json::json!({ "server": server }))?;
            match serde_json::from_str::<Vec<serde_json::Value>>(&out) {
                Ok(tools) if !tools.is_empty() => Ok(Value::Text(
                    tools.iter().map(|t| format!("- {} : {}",
                        t.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        t.get("description").and_then(|v| v.as_str()).unwrap_or("")))
                        .collect::<Vec<_>>().join("\n"),
                )),
                Ok(_) => Ok(Value::Text("Aucun outil exposé par ce connecteur.".into())),
                Err(_) => Ok(Value::Text(out)),
            }
        }
    );
    reg!(
        e,
        spec("mcp_server", "Serveur MCP (avancé)", "JSON-RPC brut vers une URL MCP, sans passer par le registre de connecteurs. À réserver aux cas non couverts par le bloc « Outil MCP ».", "MCP", "server",
            vec![
                p("url", "URL du serveur MCP", ParamKind::Text).required().placeholder("http://127.0.0.1:3000/mcp"),
                p("method", "Méthode MCP", select(&["tools/list", "tools/call", "resources/list", "resources/read", "prompts/list", "prompts/get"])),
                p("tool", "Nom de l'outil / ressource / prompt", ParamKind::Text).placeholder("search"),
                p("arguments", "Arguments JSON", ParamKind::Multiline).placeholder("{\n  \"query\": \"{{input}}\"\n}"),
                p("headers", "Headers", ParamKind::Multiline).placeholder("Authorization: Bearer {{token}}"),
            ], true),
        |params, _ctx| {
            let url = param_text(params, "url");
            if url.is_empty() { anyhow::bail!("URL MCP vide"); }
            let method = param_text(params, "method");
            let target = param_text(params, "tool");
            let args_raw = param_text(params, "arguments");
            let args_json = if args_raw.trim().is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str::<serde_json::Value>(&args_raw)
                    .map_err(|e| anyhow::anyhow!("Arguments JSON invalides : {e}"))?
            };
            let rpc_params = match method.as_str() {
                "tools/call" => serde_json::json!({ "name": target, "arguments": args_json }),
                "resources/read" => serde_json::json!({ "uri": target }),
                "prompts/get" => serde_json::json!({ "name": target, "arguments": args_json }),
                _ => args_json,
            };
            let body = serde_json::json!({
                "jsonrpc": "2.0",
                "id": format!("fluxo-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()),
                "method": method,
                "params": rpc_params,
            });
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .map_err(|e| anyhow::anyhow!("Client MCP indisponible : {e}"))?;
            let mut headers = parse_http_headers(&param_text(params, "headers"))?;
            insert_http_header(&mut headers, "Content-Type", "application/json")?;
            let text = client.post(&url)
                .headers(headers)
                .body(body.to_string())
                .send()
                .and_then(|r| r.error_for_status())
                .and_then(|r| r.text())
                .map_err(|e| anyhow::anyhow!("Appel MCP échoué : {e}"))?;
            let json = serde_json::from_str::<serde_json::Value>(&text)
                .map_err(|e| anyhow::anyhow!("Réponse MCP non JSON : {e}"))?;
            if let Some(err) = json.get("error") {
                anyhow::bail!("Erreur MCP : {err}");
            }
            Ok(crate::value::json_to_value(json.get("result").unwrap_or(&json)))
        }
    );
    reg!(
        e,
        spec("open_url", "Ouvrir une URL", "Ouvre une URL dans le navigateur par défaut.", "Web", "external-link",
            vec![p("url", "URL", ParamKind::Text).required().placeholder("{{input}}")], false),
        |params, _ctx| {
            let url = param_text(params, "url");
            open_path(&url)?;
            Ok(Value::Text(url))
        }
    );

    // ===================== SYSTÈME =====================
    reg!(
        e,
        spec("notification", "Notification", "Affiche une notification dans la capsule Halo de Lumen (bandeau haut de l'écran).", "Système", "bell",
            vec![
                p("title", "Titre", ParamKind::Text).required(),
                p("body", "Message", ParamKind::Multiline).placeholder("{{input}}"),
            ], false),
        |params, _ctx| {
            let title = param_text(params, "title");
            let body = param_text(params, "body");
            if crate::lumen::try_notify("info", &title, &body) {
                return Ok(Value::Bool(true));
            }
            anyhow::bail!("Lumen injoignable : la notification nécessite l'app Lumen ouverte.");
        }
    );
    reg!(
        e,
        spec("notify_center", "Centre de notifications", "Publie une notification persistante dans le centre de notifications de Lumen (la cloche) et dans la capsule Halo, avec badge non-lu.", "Système", "bell",
            vec![
                p("title", "Titre", ParamKind::Text).required(),
                p("body", "Message", ParamKind::Multiline).placeholder("{{input}}"),
            ], false),
        |params, _ctx| {
            let title = param_text(params, "title");
            let body = param_text(params, "body");
            if !crate::lumen::try_notify_center(&title, &body, true) {
                anyhow::bail!("Lumen injoignable : le centre de notifications nécessite l'app Lumen ouverte.");
            }
            Ok(Value::Bool(true))
        }
    );
    reg!(
        e,
        spec("speak", "Énoncer le texte", "Lit un texte à voix haute (synthèse vocale du système).", "Système", "volume-2",
            vec![
                p("text", "Texte", ParamKind::Multiline).placeholder("{{input}}"),
                p("voice", "Voix", ParamKind::Text).placeholder("Voix système (vide = voix par défaut)"),
            ], false),
        |params, _ctx| {
            let voice = param_text(params, "voice");
            Ok(Value::Bool(speak_system_text_lang_voice(
                &param_text(params, "text"), None, (!voice.trim().is_empty()).then_some(voice.as_str())
            )?))
        }
    );
    reg!(
        e,
        spec("copy_clipboard", "Copier dans le presse-papier", "Place un texte dans le presse-papier.", "Système", "clipboard",
            vec![p("text", "Texte", ParamKind::Multiline).placeholder("{{input}}")], true),
        |params, _ctx| {
            let text = param_text(params, "text");
            arboard::Clipboard::new().and_then(|mut c| c.set_text(text.clone()))
                .map_err(|e| anyhow::anyhow!("Presse-papier indisponible : {e}"))?;
            Ok(Value::Text(text))
        }
    );
    reg!(
        e,
        spec("get_clipboard", "Lire le presse-papier", "Récupère le texte du presse-papier.", "Système", "clipboard",
            vec![], true),
        |_params, _ctx| {
            let text = arboard::Clipboard::new().and_then(|mut c| c.get_text())
                .map_err(|e| anyhow::anyhow!("Presse-papier indisponible : {e}"))?;
            Ok(Value::Text(text))
        }
    );
    reg!(
        e,
        spec("wait", "Attendre", "Met l'exécution en pause quelques secondes.", "Système", "clock",
            vec![p("seconds", "Secondes", ParamKind::Number)], true),
        |params, ctx| {
            let secs = param_num(params, "seconds").max(0.0);
            std::thread::sleep(std::time::Duration::from_secs_f64(secs));
            Ok(ctx.input.clone())
        }
    );
    reg!(
        e,
        spec("comment", "Commentaire", "Note explicative (sans effet sur l'exécution).", "Système", "message-square",
            vec![p("text", "Note", ParamKind::Multiline)], false),
        |_params, ctx| Ok(ctx.input.clone())
    );
    reg!(
        e,
        spec("run_script", "Exécuter un script", "Lance une commande shell du système.", "Scripts", "terminal",
            vec![p("command", "Commande", ParamKind::Multiline).required().placeholder("echo {{input}}")], true),
        |params, _ctx| run_shell(&param_text(params, "command"))
    );

    // ===================== IA (Ollama) =====================
    // Inférence locale via Ollama : permet de construire des workflows agentiques
    // (génération, classification, extraction, routage…) sans bricoler de requête
    // HTTP. Quand le workflow est piloté par Lumen, `{{model}}` et `{{ollama_url}}`
    // sont injectés ; en autonome, des valeurs par défaut raisonnables s'appliquent.
    reg!(
        e,
        spec("ollama_generate", "Ollama (génération)", "Interroge un modèle local Ollama et renvoie sa réponse texte.", "IA", "cpu",
            vec![
                p("prompt", "Invite", ParamKind::Multiline).required().placeholder("{{input}}"),
                p("system", "Consigne système", ParamKind::Multiline).placeholder("Tu es un assistant concis…"),
                p("model", "Modèle", ParamKind::Text).placeholder("{{model}} ou llama3.1"),
                p("url", "URL Ollama", ParamKind::Text).placeholder("{{ollama_url}} ou http://localhost:11434"),
            ], true),
        |params, _ctx| {
            let prompt = param_text(params, "prompt");
            let system = param_text(params, "system");
            let model = { let m = param_text(params, "model"); if m.is_empty() { "llama3.1".into() } else { m } };
            let url = { let u = param_text(params, "url"); if u.is_empty() { "http://localhost:11434".into() } else { u } };
            let answer = ollama_generate(&url, &model, &prompt, &system)?;
            Ok(Value::Text(answer))
        }
    );

    reg!(
        e,
        spec("api_generate", "IA cloud (génération)", "Interroge une IA cloud compatible OpenAI (ChatGPT, Groq, OpenRouter…) et renvoie sa réponse texte. Laisse la clé vide pour réutiliser celle de Lumen.", "IA", "cloud",
            vec![
                p("prompt", "Invite", ParamKind::Multiline).required().placeholder("{{input}}"),
                p("system", "Consigne système", ParamKind::Multiline).placeholder("Tu es un assistant concis…"),
                p("model", "Modèle", ParamKind::Text).placeholder("vide = modèle Lumen, ou gpt-4o-mini"),
                p("base_url", "URL de base de l'API", ParamKind::Text).placeholder("vide = config Lumen, ou https://api.openai.com/v1"),
                p("api_key", "Clé API", ParamKind::Text).placeholder("vide = clé Lumen"),
            ], true),
        |params, _ctx| {
            // Champs vides → repli sur la config Lumen exportée en variables d'env.
            let prompt = param_text(params, "prompt");
            let system = param_text(params, "system");
            let model = {
                let m = param_text(params, "model");
                if !m.is_empty() { m }
                else { let e = std::env::var("LUMEN_LLM_API_MODEL").unwrap_or_default(); if e.is_empty() { "gpt-4o-mini".into() } else { e } }
            };
            let base = {
                let b = param_text(params, "base_url");
                if !b.is_empty() { b }
                else { let e = std::env::var("LUMEN_LLM_API_BASE").unwrap_or_default(); if e.is_empty() { "https://api.openai.com/v1".into() } else { e } }
            };
            let key = {
                let k = param_text(params, "api_key");
                if !k.is_empty() { k } else { crate::host_api_key() }
            };
            if key.is_empty() {
                anyhow::bail!("Aucune clé API : renseigne-la dans le bloc ou active la source « API cloud » dans Lumen.");
            }
            let mut msgs: Vec<serde_json::Value> = Vec::new();
            if !system.is_empty() {
                msgs.push(serde_json::json!({ "role": "system", "content": system }));
            }
            msgs.push(serde_json::json!({ "role": "user", "content": prompt }));
            let answer = openai_chat(&base, &key, &model, &msgs)?;
            Ok(Value::Text(answer))
        }
    );

    reg!(
        e,
        spec("llm_infer", "Inférence LLM", "Nœud d'inférence complet : choisit le backend (Ollama, llama.cpp local ou API cloud), le modèle, le raisonnement et la taille de contexte. Il convient aux étapes robustes d'un workflow agentique.", "IA", "sparkles",
            vec![
                p("prompt", "Invite", ParamKind::Multiline).required().placeholder("{{input}}"),
                p("system", "Consigne système", ParamKind::Multiline).placeholder("Tu es un assistant précis et concis."),
                p("backend", "Backend", select(&["auto", "ollama", "llama", "api"])),
                p("model", "Modèle", ParamKind::Text).placeholder("vide = modèle configuré dans Lumen"),
                p("think", "Mode réflexion", ParamKind::Bool),
                p("context_size", "Taille de contexte", ParamKind::Number).placeholder("0 = valeur du modèle"),
                p("ollama_url", "URL Ollama", ParamKind::Text).placeholder("http://localhost:11434"),
                p("llama_url", "URL llama-server", ParamKind::Text).placeholder("vide = serveur local de Lumen (11435)"),
                p("api_base_url", "URL API compatible OpenAI", ParamKind::Text).placeholder("vide = configuration Lumen"),
                p("api_key", "Clé API", ParamKind::Text).placeholder("vide = clé configurée dans Lumen"),
            ], true),
        |params, _ctx| {
            let backend = param_text(params, "backend");
            let requested_model = param_text(params, "model");
            let think = matches!(params.get("think"), Some(Value::Bool(true)));
            let context_size = param_num(params, "context_size").max(0.0) as u64;
            let prompt = param_text(params, "prompt");
            let system = param_text(params, "system");
            // llama.cpp explicite : serveur local de Lumen, API OpenAI-compatible
            // sans clé. Le modèle est un fichier GGUF installé ; on demande à
            // Lumen de démarrer (ou de basculer) le serveur dessus avant
            // d'interroger, comme le fait la barre quand on change de modèle.
            if backend == "llama" {
                let base = {
                    let v = param_text(params, "llama_url");
                    if !v.is_empty() { v } else { llama_base_url() }
                };
                let model = if requested_model.is_empty() {
                    std::env::var("LUMEN_LLM_API_MODEL").unwrap_or_default()
                } else { requested_model };
                if model.is_empty() {
                    anyhow::bail!("Modèle llama.cpp requis : choisis un fichier GGUF installé (ou laisse Lumen en source llama.cpp).");
                }
                ensure_llama_model(&model);
                let mut messages = Vec::new();
                if !system.is_empty() { messages.push(serde_json::json!({"role":"system","content":system})); }
                messages.push(serde_json::json!({"role":"user","content":prompt}));
                return openai_chat_configured(&base, "", &model, &messages, think, context_size).map(Value::Text);
            }
            let use_api = backend == "api" || (backend != "ollama" && llm_api_override().is_some());
            if use_api {
                let (configured_base, configured_key, configured_model) = llm_api_override().unwrap_or_else(|| (
                    "https://api.openai.com/v1".into(), crate::host_api_key(),
                    std::env::var("LUMEN_LLM_API_MODEL").unwrap_or_default(),
                ));
                let key = { let v = param_text(params, "api_key"); if v.is_empty() { configured_key } else { v } };
                if key.is_empty() { anyhow::bail!("Clé API absente : configure-la dans Lumen ou dans le nœud."); }
                let base = { let v = param_text(params, "api_base_url"); if v.is_empty() { configured_base } else { v } };
                let model = if requested_model.is_empty() { configured_model } else { requested_model };
                if model.is_empty() { anyhow::bail!("Modèle API requis"); }
                // Backend « auto » alors que Lumen tourne en llama.cpp : la base
                // pointe sur le serveur local, qui peut être à l'arrêt (ou sur un
                // autre GGUF). On le met en route comme le fait la barre.
                if std::env::var("LUMEN_LLM_BACKEND").unwrap_or_default() == "llama" {
                    ensure_llama_model(&model);
                }
                let mut messages = Vec::new();
                if !system.is_empty() { messages.push(serde_json::json!({"role":"system","content":system})); }
                messages.push(serde_json::json!({"role":"user","content":prompt}));
                return openai_chat_configured(&base, &key, &model, &messages, think, context_size).map(Value::Text);
            }
            let model = if requested_model.is_empty() { "llama3.1".into() } else { requested_model };
            let url = { let v = param_text(params, "ollama_url"); if v.is_empty() { "http://localhost:11434".into() } else { v } };
            ollama_generate_configured(&url, &model, &prompt, &system, think, context_size).map(Value::Text)
        }
    );

    reg!(
        e,
        spec("ollama_chat", "Ollama (chat multi-tours)", "Conversation multi-tours : prend un historique de messages (JSON), y ajoute un tour, et renvoie la réponse de l'assistant.", "IA", "message-square",
            vec![
                p("messages", "Historique (JSON)", ParamKind::Multiline).placeholder("[{\"role\":\"user\",\"content\":\"Bonjour\"}] ou {{input}}"),
                p("prompt", "Nouveau message utilisateur", ParamKind::Text).placeholder("Message à ajouter (optionnel)"),
                p("system", "Consigne système", ParamKind::Multiline).placeholder("Tu es un assistant concis…"),
                p("model", "Modèle", ParamKind::Text).placeholder("{{model}} ou llama3.1"),
                p("url", "URL Ollama", ParamKind::Text).placeholder("{{ollama_url}} ou http://localhost:11434"),
            ], true),
        |params, _ctx| {
            let model = { let m = param_text(params, "model"); if m.is_empty() { "llama3.1".into() } else { m } };
            let url = { let u = param_text(params, "url"); if u.is_empty() { "http://localhost:11434".into() } else { u } };
            let system = param_text(params, "system");
            let prompt = param_text(params, "prompt");

            // Historique : un tableau JSON [{role, content}, …] ; vide/absent → []
            let raw = param_text(params, "messages");
            let mut messages: Vec<serde_json::Value> = if raw.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str(&raw)
                    .map_err(|e| anyhow::anyhow!("Historique JSON invalide (tableau de messages attendu) : {e}"))?
            };

            // Consigne système en tête si absente.
            if !system.is_empty()
                && !messages.first().and_then(|m| m.get("role")).and_then(|r| r.as_str()).is_some_and(|r| r == "system")
            {
                messages.insert(0, serde_json::json!({ "role": "system", "content": system }));
            }
            // Nouveau tour utilisateur.
            if !prompt.is_empty() {
                messages.push(serde_json::json!({ "role": "user", "content": prompt }));
            }
            if messages.is_empty() {
                anyhow::bail!("Aucun message à envoyer (fournis un historique et/ou un message utilisateur)");
            }

            let answer = ollama_chat(&url, &model, &messages)?;
            Ok(Value::Text(answer))
        }
    );

    // ===================== LUMEN (retours) =====================
    // Blocs qui renvoient un résultat directement dans l'UI de Lumen via son
    // serveur loopback (127.0.0.1:8765). Hors Lumen, ils échouent proprement.

    // --- Notification Lumen (enrichie : type coloré) ---
    reg!(
        e,
        spec("lumen_notification", "Notification Lumen", "Pousse une notification dans Lumen (bulle flottante + centre de notifications).", "Lumen", "bell",
            vec![
                p("kind", "Type", select(&["info", "success", "warn", "error", "prompt", "progress", "thinking"])),
                p("title", "Titre", ParamKind::Text).required(),
                p("body", "Message", ParamKind::Multiline).placeholder("{{input}}"),
                p("icon", "Icône (option)", ParamKind::Text).placeholder("bell, check, sparkles… (laisser vide = selon le type)"),
                p("color", "Couleur (option)", ParamKind::Text).placeholder("#9961ff — vide = couleur du type"),
                p("actions", "Choix (une option par ligne)", ParamKind::Multiline).placeholder("Préfixe * = bouton principal.\nFormat : id | Libellé  (ou juste Libellé)\n*ouvrir | Ouvrir\nplus_tard | Plus tard"),
                p("timeout", "Durée d'affichage (ms, option)", ParamKind::Number).placeholder("0 = durée par défaut"),
            ], false),
        |params, _ctx| {
            let kind = { let k = param_text(params, "kind"); if k.is_empty() { "info".into() } else { k } };
            let mut body = serde_json::json!({
                "kind": kind,
                "title": param_text(params, "title"),
                "body": param_text(params, "body"),
            });
            // Boutons de choix : une option par ligne. Avec des actions, la capsule
            // reste affichée jusqu'au clic (cf. /notify côté Lumen).
            let actions = parse_notification_actions(&param_text(params, "actions"));
            if !actions.is_empty() {
                body["actions"] = serde_json::Value::Array(actions);
            }
            // Icône explicite : transmise telle quelle à island.js (qui retombe sur
            // l'icône du type si le nom est inconnu/vide).
            let icon = param_text(params, "icon");
            if !icon.is_empty() {
                body["icon"] = serde_json::Value::String(icon);
            }
            // Couleur d'accent personnalisée (sinon couleur du type côté island.js).
            let color = param_text(params, "color");
            if !color.is_empty() {
                body["accent"] = serde_json::Value::String(color);
            }
            // Durée d'affichage en ms (>0 ; sinon défaut/persistant pour un prompt).
            let timeout = param_num(params, "timeout");
            if timeout > 0.0 {
                body["timeout_ms"] = serde_json::json!(timeout as u64);
            }
            crate::lumen::post_json("/notify", body)?;
            Ok(Value::Bool(true))
        }
    );

    // --- Progression (panneau de run en direct) ---
    reg!(
        e,
        spec("lumen_progress", "Progression Lumen", "Envoie un message de progression affiché en direct dans la bulle du run.", "Lumen", "activity",
            vec![
                p("message", "Message", ParamKind::Text).required().placeholder("Étape 2 sur 3…"),
                p("kind", "Catégorie", select(&["progress", "step", "status", "log", "result"])),
                p("run_id", "Run (auto)", ParamKind::Text).placeholder("{{run_id}}"),
            ], false),
        |params, ctx| {
            let kind = { let k = param_text(params, "kind"); if k.is_empty() { "progress".into() } else { k } };
            crate::lumen::post_json("/run/progress", serde_json::json!({
                "run_id": resolve_run_id(params, ctx),
                "kind": kind,
                "message": param_text(params, "message"),
            }))?;
            Ok(Value::Bool(true))
        }
    );

    // --- Widget structuré (complication dans la discussion) ---
    reg!(
        e,
        spec("reporting_export", "Exporter un rapport", "Recalcule un rapport de l'app Reporting (période et comparaison enregistrées) et écrit son PDF et/ou son HTML dans la sandbox du rapport. Sortie : les chemins écrits. Idéal derrière un déclencheur CRON.", "Lumen", "file-text",
            vec![
                p("report", "Rapport", ParamKind::Text).required().placeholder("Nom du rapport (tel qu'enregistré)"),
                p("sandbox", "Espace", ParamKind::Text).placeholder("Nom de l'espace (vide = premier espace contenant le rapport)"),
                p("format", "Format", ParamKind::Select { options: vec!["pdf".into(), "html".into(), "both".into()] }).placeholder("pdf, html ou both"),
                p("period", "Période", ParamKind::Select { options: vec!["saved".into(), "month".into(), "last-month".into(), "30-days".into(), "year".into()] }).placeholder("saved = celle du rapport"),
                p("notify", "Prévenir à la fin", ParamKind::Bool),
            ], true),
        |params, _ctx| {
            let report = param_text(params, "report");
            if report.trim().is_empty() {
                anyhow::bail!("Indique le nom du rapport à exporter.");
            }
            let format = { let f = param_text(params, "format"); if f.trim().is_empty() { "pdf".to_string() } else { f } };
            let period = { let p = param_text(params, "period"); if p.trim().is_empty() { "saved".to_string() } else { p } };
            let notify = matches!(param_text(params, "notify").to_lowercase().as_str(), "true" | "1" | "oui" | "yes");
            // Le rendu se fait dans la fenêtre de Lumen (graphiques compris) :
            // délai large, un rapport lourd peut prendre quelques dizaines de secondes.
            let raw = crate::lumen::post_json_timeout(
                "/reporting/export",
                serde_json::json!({ "report": report, "sandbox": param_text(params, "sandbox"), "format": format, "period": period, "notify": notify }),
                180,
            ).map_err(|e| anyhow::anyhow!("Export impossible : {e}. L'app Lumen doit être ouverte."))?;
            let out: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::String(raw));
            Ok(crate::value::json_to_value(&out))
        }
    );
    reg!(
        e,
        spec("lumen_widget", "Widget Lumen", "Affiche un widget structuré (gabarit + titre + données JSON) dans la discussion.", "Lumen", "layout",
            vec![
                p("template", "Gabarit", ParamKind::Text).required().placeholder("stat, list, card…"),
                p("title", "Titre", ParamKind::Text),
                p("accent", "Couleur d'accent", ParamKind::Text).placeholder("#9961ff"),
                p("data", "Données (JSON)", ParamKind::Multiline).placeholder("{{input}} ou {\"valeur\": 42}"),
                p("run_id", "Run (auto)", ParamKind::Text).placeholder("{{run_id}}"),
            ], false),
        |params, ctx| {
            // `data` peut être un JSON ; sinon on le transmet comme texte brut.
            let raw = param_text(params, "data");
            let data: serde_json::Value = serde_json::from_str(&raw)
                .unwrap_or(serde_json::Value::String(raw));
            let mut body = serde_json::json!({
                "run_id": resolve_run_id(params, ctx),
                "template": param_text(params, "template"),
                "data": data,
            });
            let title = param_text(params, "title");
            if !title.is_empty() { body["title"] = serde_json::Value::String(title); }
            let accent = param_text(params, "accent");
            if !accent.is_empty() { body["accent"] = serde_json::Value::String(accent); }
            crate::lumen::post_json("/run/widget", body)?;
            Ok(Value::Bool(true))
        }
    );

    // --- Génération d'image (Bonsai local ou OpenAI), déposée en sandbox ---
    reg!(
        e,
        spec("lumen_image", "Générer une image", "Génère une image à partir d'un prompt et l'enregistre dans une sandbox Lumen. Choisis le backend (Bonsai ou Ollama en local, OpenAI en cloud, Image Playground d'Apple — feuille système à valider, macOS 27) et la sandbox de destination. Renvoie le chemin du fichier créé.", "Lumen", "sparkles",
            vec![
                p("prompt", "Description (prompt)", ParamKind::Multiline).required().placeholder("{{input}} — ex. un renard origami sur fond pastel"),
                p("backend", "Backend", select(&["auto", "bonsai", "openai", "ollama", "playground"])),
                p("model", "Modèle (option)", ParamKind::Text).placeholder("Bonsai : ternary, binary · Ollama : flux, sdxl-turbo · OpenAI : gpt-image-1, dall-e-3 · Playground : any, illustration, animation, sketch"),
                p("sandbox", "Sandbox de destination (nom)", ParamKind::Text).required().placeholder("Nom d'une sandbox Lumen"),
                p("path", "Chemin du fichier", ParamKind::Text).placeholder("images/sortie.png (défaut : images/fluxo-<horodatage>.png)"),
                p("width", "Largeur (px, option)", ParamKind::Number).placeholder("512 (Bonsai) / 1024 (OpenAI)"),
                p("height", "Hauteur (px, option)", ParamKind::Number).placeholder("512 (Bonsai) / 1024 (OpenAI)"),
            ], true),
        |params, _ctx| {
            let prompt = param_text(params, "prompt");
            if prompt.trim().is_empty() { anyhow::bail!("Prompt manquant"); }
            let sandbox = param_text(params, "sandbox");
            if sandbox.trim().is_empty() { anyhow::bail!("Sandbox de destination manquante"); }
            // « auto » (défaut) = le moteur d'image choisi dans les réglages de Lumen.
            let backend = { let b = param_text(params, "backend"); if b.trim().is_empty() { "auto".into() } else { b } };
            let path = {
                let p = param_text(params, "path");
                if p.trim().is_empty() {
                    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                    format!("images/fluxo-{ts}.png")
                } else { p }
            };
            let mut body = serde_json::json!({
                "name": sandbox,
                "path": path,
                "prompt": prompt,
                "backend": backend,
            });
            // Modèle propre au backend choisi. Vide = celui par défaut du
            // moteur côté Lumen.
            let model = param_text(params, "model");
            if !model.trim().is_empty() { body["model"] = serde_json::json!(model.trim()); }
            let w = param_num(params, "width");
            if w > 0.0 { body["width"] = serde_json::json!(w as u32); }
            let h = param_num(params, "height");
            if h > 0.0 { body["height"] = serde_json::json!(h as u32); }
            // Génération longue : timeout généreux (4 min).
            let saved = crate::lumen::post_json_timeout("/image/generate", body, 240)?;
            Ok(Value::Text(saved))
        }
    );

    // --- Mémoire cognitive : rappel ---
    reg!(
        e,
        spec("lumen_memory_recall", "Rappeler mémoire", "Recherche dans les souvenirs cognitifs de Lumen (soumis aux permissions du contexte choisi) et renvoie les souvenirs pertinents sous forme de texte.", "Lumen", "brain",
            vec![
                p("query", "Recherche", ParamKind::Text).required().placeholder("{{input}}"),
                p("context", "Contexte d'accès", select(&["fluxo", "agent", "bar", "domotique", "studies", "notes", "mindmap", "studio", "moodboard"])),
                p("kinds", "Types", select(&["", "semantic", "procedural", "episodic", "session"])),
                p("limit", "Nombre de souvenirs", ParamKind::Text).placeholder("5"),
            ], true),
        |params, _ctx| {
            let query = param_text(params, "query");
            if query.trim().is_empty() { anyhow::bail!("Recherche vide"); }
            let context = {
                let c = param_text(params, "context");
                if c.trim().is_empty() { "agent".to_string() } else { c }
            };
            let limit: usize = param_text(params, "limit").trim().parse().unwrap_or(5);
            let kinds = param_text(params, "kinds");
            let mut body = serde_json::json!({ "query": query, "context": context, "limit": limit });
            if !kinds.trim().is_empty() { body["kinds"] = serde_json::json!([kinds.trim()]); }
            let resp = crate::lumen::post_json("/recall/search", body)?;
            match serde_json::from_str::<Vec<serde_json::Value>>(&resp) {
                Ok(items) if !items.is_empty() => {
                    let out = items.iter().map(|it| {
                        let kind = it.get("kind").and_then(|v| v.as_str()).unwrap_or("memory");
                        let text = it.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        format!("- [{kind}] {text}")
                    }).collect::<Vec<_>>().join("\n");
                    Ok(Value::Text(out))
                }
                _ => Ok(Value::Text(String::new())),
            }
        }
    );

    // --- Mémoire cognitive : écriture ---
    reg!(
        e,
        spec("lumen_memory_remember", "Mémoriser", "Ajoute un souvenir cognitif explicite dans Lumen. Utiliser pour des faits ou décisions clairement formulés ; ne pas stocker d'information sensible sans demande explicite.", "Lumen", "save",
            vec![
                p("text", "Souvenir", ParamKind::Multiline).required().placeholder("{{input}}"),
                p("kind", "Type", select(&["semantic", "procedural", "episodic", "session"])),
                p("context", "Contexte d'accès", select(&["fluxo", "agent", "bar", "domotique", "studies", "notes", "mindmap", "studio", "moodboard"])),
                p("tags", "Tags (virgules)", ParamKind::Text).placeholder("projet, décision"),
            ], true),
        |params, _ctx| {
            let text = param_text(params, "text");
            if text.trim().is_empty() { anyhow::bail!("Souvenir vide"); }
            let kind = {
                let k = param_text(params, "kind");
                if k.trim().is_empty() { "semantic".to_string() } else { k }
            };
            let context = {
                let c = param_text(params, "context");
                if c.trim().is_empty() { "agent".to_string() } else { c }
            };
            let tags = param_text(params, "tags")
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>();
            let resp = crate::lumen::post_json("/recall/remember", serde_json::json!({
                "text": text,
                "kind": kind,
                "context": context,
                "tags": tags,
                "source": "Fluxo",
            }))?;
            match serde_json::from_str::<serde_json::Value>(&resp) {
                Ok(v) => Ok(Value::Text(v.get("text").and_then(|x| x.as_str()).unwrap_or("Souvenir enregistré.").to_string())),
                Err(_) => Ok(Value::Text(resp)),
            }
        }
    );

    // --- Consolidation de la mémoire cognitive ---
    reg!(
        e,
        spec("lumen_memory_consolidate", "Consolider la mémoire", "Digère les souvenirs épisodiques récents de Lumen en connaissances durables (faits sémantiques, habitudes, récit) à l'aide de l'IA active. Renvoie un compte rendu JSON. À planifier (ex. via le heartbeat) pour entretenir la mémoire.", "Lumen", "brain",
            vec![], true),
        |_params, _ctx| {
            // Opération potentiellement longue (appel LLM) : timeout généreux.
            let out = crate::lumen::post_json_timeout("/mem/consolidate", serde_json::json!({}), 240)?;
            Ok(Value::Text(out))
        }
    );

    // --- Recherche dans la base de connaissances (RAG) ---
    reg!(
        e,
        spec("lumen_rag_search", "Rechercher dans les connaissances", "Recherche les extraits les plus pertinents dans la base de connaissances (RAG) de Lumen — documents importés, vectorisés en local. Renvoie les passages trouvés, à réutiliser dans la suite du workflow.", "Lumen", "search",
            vec![
                p("query", "Recherche", ParamKind::Text).required().placeholder("{{input}}"),
                p("k", "Nombre d'extraits", ParamKind::Text).placeholder("5"),
            ], true),
        |params, _ctx| {
            let query = param_text(params, "query");
            if query.is_empty() { anyhow::bail!("Recherche vide"); }
            let k: usize = param_text(params, "k").trim().parse().unwrap_or(5);
            let resp = crate::lumen::post_json("/rag/search", serde_json::json!({ "query": query, "k": k }))?;
            // Réponse = tableau JSON d'extraits { text, title, doc_id, distance }.
            // On renvoie un texte lisible, exploitable par les blocs suivants.
            match serde_json::from_str::<Vec<serde_json::Value>>(&resp) {
                Ok(hits) if !hits.is_empty() => {
                    let joined = hits.iter().enumerate().map(|(i, h)| {
                        format!("[{}] ({}) {}", i + 1,
                            h.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                            h.get("text").and_then(|v| v.as_str()).unwrap_or(""))
                    }).collect::<Vec<_>>().join("\n\n");
                    Ok(Value::Text(joined))
                }
                _ => Ok(Value::Text(String::new())),
            }
        }
    );

    // --- Bases de données SQL locales : requête lecture seule ---
    reg!(
        e,
        spec("lumen_table_query", "Interroger une base de données", "Exécute une requête SQL de lecture (SELECT) sur une base de données Lumen (app « Bases de données »). Indique l'identifiant de la base et la requête. Renvoie les lignes trouvées (texte tabulé), réutilisables par les blocs suivants. Seules les requêtes de lecture sont autorisées.", "Lumen", "database",
            vec![
                p("base_id", "Identifiant de la base", ParamKind::Text).required().placeholder("ex. 3f9a… (visible dans l'app Bases de données)"),
                p("sql", "Requête SQL (SELECT)", ParamKind::Multiline).required().placeholder("SELECT * FROM \"Ma table\" LIMIT 50"),
            ], true),
        |params, _ctx| {
            let base_id = param_text(params, "base_id");
            let sql = param_text(params, "sql");
            if base_id.is_empty() || sql.is_empty() { anyhow::bail!("Base ou requête manquante"); }
            let resp = crate::lumen::post_json("/tables/query", serde_json::json!({ "base_id": base_id, "sql": sql }))?;
            // Réponse = { columns: [..], rows: [[..]] }. On rend un texte tabulé lisible.
            match serde_json::from_str::<serde_json::Value>(&resp) {
                Ok(v) => {
                    let cols = v.get("columns").and_then(|c| c.as_array()).cloned().unwrap_or_default();
                    let rows = v.get("rows").and_then(|r| r.as_array()).cloned().unwrap_or_default();
                    let header = cols.iter().map(|c| c.as_str().unwrap_or("").to_string()).collect::<Vec<_>>().join("\t");
                    let mut out = vec![header];
                    for row in rows {
                        if let Some(cells) = row.as_array() {
                            out.push(cells.iter().map(|c| match c {
                                serde_json::Value::Null => String::new(),
                                serde_json::Value::String(s) => s.clone(),
                                other => other.to_string(),
                            }).collect::<Vec<_>>().join("\t"));
                        }
                    }
                    Ok(Value::Text(out.join("\n")))
                }
                _ => Ok(Value::Text(resp)),
            }
        }
    );

    // --- Badge RFID du Lumen Controller ---
    //
    // Pendant du déclencheur `Trigger::Rfid` : le déclencheur lance le workflow
    // quand un badge est posé, ce bloc permet de LIRE le lecteur au milieu d'un
    // workflow (« pose ton badge pour valider »), ou de relire l'UID plus loin
    // dans la chaîne, une fois `{{input}}` recouvert par d'autres étapes.
    reg!(
        e,
        spec("lumen_rfid_badge", "Badge RFID", "Lit le lecteur RFID du Lumen Controller : renvoie l'UID du badge posé, son libellé s'il est associé, et s'il est présent. Avec un délai d'attente, le workflow attend qu'un badge soit posé (utile pour valider une étape par badge).", "Lumen", "credit-card",
            vec![
                p("wait_seconds", "Attendre un badge (secondes, 0 = non)", ParamKind::Number)
                    .placeholder("0"),
                p("field", "Renvoyer", select(&["uid", "label", "tout"])),
            ], true),
        |params, _ctx| {
            let wait = param_num(params, "wait_seconds").max(0.0);
            let field = {
                let f = param_text(params, "field");
                if f.is_empty() { "uid".to_string() } else { f }
            };
            // Attente active : le serveur loopback expose l'état courant du
            // lecteur, il n'y a pas de canal poussé jusqu'au moteur. 300 ms est
            // sous le seuil de perception et reste discret pour l'application.
            let deadline = Instant::now() + Duration::from_secs_f64(wait);
            let badge = loop {
                let raw = crate::lumen::get_text("/rfid/last")?;
                let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
                let present = v.get("present").and_then(|x| x.as_bool()).unwrap_or(false);
                if present || Instant::now() >= deadline {
                    break v;
                }
                std::thread::sleep(Duration::from_millis(300));
            };
            let uid = badge.get("uid").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let label = badge.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string();
            Ok(match field.as_str() {
                "label" => Value::Text(label),
                "tout" => crate::value::json_to_value(&badge),
                _ => Value::Text(uid),
            })
        }
    );

    // --- Mémoire partagée : écriture ---
    reg!(
        e,
        spec("memory_set", "Mémoire : écrire", "Écrit une valeur dans la mémoire partagée Lumen (clé → valeur).", "Lumen", "save",
            vec![
                p("key", "Clé", ParamKind::Text).required().placeholder("todo/last"),
                p("value", "Valeur", ParamKind::Multiline).placeholder("{{input}}"),
            ], true),
        |params, _ctx| {
            let key = param_text(params, "key");
            if key.is_empty() { anyhow::bail!("Clé vide"); }
            let raw = param_text(params, "value");
            // Valeur JSON si possible (objet/tableau/nombre), sinon texte brut.
            let value: serde_json::Value = serde_json::from_str(&raw)
                .unwrap_or(serde_json::Value::String(raw.clone()));
            crate::lumen::put_json(&format!("/mem/{key}"), value)?;
            Ok(Value::Text(raw))
        }
    );

    // --- Mémoire partagée : lecture ---
    reg!(
        e,
        spec("memory_get", "Mémoire : lire", "Lit une valeur de la mémoire partagée Lumen (vide si absente).", "Lumen", "folder",
            vec![p("key", "Clé", ParamKind::Text).required().placeholder("todo/last")], true),
        |params, _ctx| {
            let key = param_text(params, "key");
            if key.is_empty() { anyhow::bail!("Clé vide"); }
            let raw = crate::lumen::get_text(&format!("/mem/{key}"))?;
            if raw.is_empty() { return Ok(Value::Null); }
            // La réponse est une entrée { value, rev, updated_at… } : on extrait
            // `value` et on la renvoie comme texte exploitable par les blocs suivants.
            match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(entry) => {
                    let v = entry.get("value").cloned().unwrap_or(serde_json::Value::Null);
                    Ok(crate::value::json_to_value(&v))
                }
                Err(_) => Ok(Value::Text(raw)),
            }
        }
    );
    reg!(
        e,
        spec("run_agent", "Lancer un agent", "Déclenche un agent Lumen. Sans demande, il traite la prochaine tâche de sa todo (idéal depuis le Heartbeat). Avec une demande, il la traite immédiatement avec ses compétences, son instruction et sa sandbox, et le bloc renvoie son compte rendu.", "Lumen", "cpu",
            vec![
                p("agent", "Agent (nom)", ParamKind::Text).required().placeholder("Nom exact de l'agent"),
                p("prompt", "Demande", ParamKind::Multiline).placeholder("optionnel — {{input}} : la demande à traiter"),
            ], true),
        |params, _ctx| {
            let agent = param_text(params, "agent");
            let prompt = param_text(params, "prompt");
            if agent.is_empty() { anyhow::bail!("Nom d'agent requis"); }
            if !prompt.trim().is_empty() {
                // Avec une demande, l'agent RÉPOND : on attend le compte rendu.
                // Une boucle agentique dure bien plus que les 5 s du client par
                // défaut, d'où le délai large (comme la génération d'image).
                let report = crate::lumen::post_json_timeout(
                    "/agent/run",
                    serde_json::json!({ "agent": agent, "prompt": prompt }),
                    1800,
                )?;
                return Ok(Value::Text(report));
            }
            let resp = crate::lumen::post_json("/agent/run", serde_json::json!({ "agent": agent }))?;
            Ok(Value::Text(if resp.trim().is_empty() || resp.trim() == "ok" {
                format!("Agent « {agent} » lancé")
            } else {
                resp
            }))
        }
    );
    reg!(
        e,
        spec("agent_add_task", "Ajouter une tâche à un agent", "Ajoute une tâche à la todo list d'un agent Lumen. Combinable avec le chat : un workflow routé peut transformer la demande en tâche.", "Lumen", "list",
            vec![
                p("agent", "Agent (nom)", ParamKind::Text).required().placeholder("Nom exact de l'agent"),
                p("task", "Tâche", ParamKind::Multiline).required().placeholder("{{input}}"),
                p("due", "Date d'exécution (epoch secondes)", ParamKind::Number).placeholder("optionnel — minuit local"),
            ], true),
        |params, _ctx| {
            let agent = param_text(params, "agent");
            let task = param_text(params, "task");
            let due_num = param_num(params, "due");
            let due = if due_num > 0.0 { Some(due_num as i64) } else { None };
            if agent.is_empty() { anyhow::bail!("Nom d'agent requis"); }
            if task.trim().is_empty() { anyhow::bail!("Tâche vide"); }
            let resp = crate::lumen::post_json(
                "/agent/task",
                serde_json::json!({ "agent": agent, "text": task, "due": due }),
            )?;
            Ok(Value::Text(if resp.trim().is_empty() || resp.trim() == "ok" {
                format!("Tâche ajoutée à « {agent} »")
            } else {
                resp
            }))
        }
    );
    reg!(
        e,
        spec("calendar_add_reminder", "Calendrier : créer un rappel", "Ajoute un rappel dans le calendrier Lumen. Indique une date epoch en millisecondes, ou un délai relatif en millisecondes.", "Lumen", "calendar",
            vec![
                p("title", "Titre", ParamKind::Text).required().placeholder("Préparer le compte rendu"),
                p("note", "Note", ParamKind::Multiline).placeholder("Contexte optionnel"),
                p("due_at", "Échéance (epoch millisecondes)", ParamKind::Number).placeholder("Ex. 1760000000000"),
                p("due_in_ms", "Dans combien de temps (millisecondes)", ParamKind::Number).placeholder("Ex. 3600000 pour 1 heure"),
                p("recur", "Récurrence", select(&["none", "daily", "weekly", "monthly"])),
            ], true),
        |params, _ctx| {
            let title = param_text(params, "title");
            if title.trim().is_empty() { anyhow::bail!("Titre du rappel requis"); }
            let due_at = param_num(params, "due_at");
            let due_in_ms = param_num(params, "due_in_ms");
            if due_at <= 0.0 && due_in_ms <= 0.0 {
                anyhow::bail!("Renseigne une échéance ou un délai pour le rappel");
            }
            let resp = crate::lumen::post_json(
                "/reminders",
                serde_json::json!({
                    "title": title,
                    "note": param_text(params, "note"),
                    "due_at": (due_at > 0.0).then_some(due_at as u64),
                    "due_in_ms": (due_in_ms > 0.0).then_some(due_in_ms as u64),
                    "recur": param_text(params, "recur"),
                }),
            )?;
            Ok(Value::Text(if resp.trim().is_empty() || resp.trim() == "ok" {
                "Rappel ajouté au calendrier".into()
            } else { resp }))
        }
    );
    reg!(
        e,
        spec("kanban_add_card", "Kanban : créer une carte", "Ajoute une carte dans le tableau Kanban Lumen. La colonne peut être donnée par son nom ou son identifiant.", "Lumen", "kanban",
            vec![
                p("title", "Titre", ParamKind::Text).required().placeholder("Traiter le compte rendu"),
                p("description", "Description", ParamKind::Multiline).placeholder("{{last}}"),
                p("column", "Colonne", ParamKind::Text).placeholder("À faire (par défaut)"),
            ], true),
        |params, _ctx| {
            let title = param_text(params, "title");
            if title.trim().is_empty() { anyhow::bail!("Titre de carte requis"); }
            let resp = crate::lumen::post_json(
                "/kanban/cards",
                serde_json::json!({
                    "title": title,
                    "description": param_text(params, "description"),
                    "column": param_text(params, "column"),
                }),
            )?;
            Ok(Value::Text(if resp.trim().is_empty() || resp.trim() == "ok" {
                "Carte ajoutée au Kanban".into()
            } else { resp }))
        }
    );
    reg!(
        e,
        spec("inbox_post_message", "Messagerie : écrire un message", "Ajoute un message dans la messagerie intégrée du workspace. Utile pour les workflows, agents et rapports automatisés.", "Lumen", "mail",
            vec![
                p("from", "Expéditeur", ParamKind::Text).required().placeholder("Workflow Fluxo"),
                p("from_id", "Id expéditeur (optionnel)", ParamKind::Text).placeholder("agent-id ou workflow-id"),
                p("subject", "Sujet", ParamKind::Text).required().placeholder("Rapport terminé"),
                p("body", "Message", ParamKind::Multiline).placeholder("{{input}}"),
                p("task", "Contexte JSON (optionnel)", ParamKind::Multiline).placeholder("{\"source\":\"fluxo\"}"),
            ], true),
        |params, _ctx| {
            let from = param_text(params, "from");
            let subject = param_text(params, "subject");
            if from.trim().is_empty() { anyhow::bail!("Expéditeur requis"); }
            if subject.trim().is_empty() { anyhow::bail!("Sujet requis"); }
            let task_raw = param_text(params, "task");
            let task: serde_json::Value = if task_raw.trim().is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::from_str(&task_raw)
                    .map_err(|e| anyhow::anyhow!("Contexte JSON invalide : {e}"))?
            };
            let resp = crate::lumen::post_json(
                "/inbox/post",
                serde_json::json!({
                    "from": from,
                    "from_id": param_text(params, "from_id"),
                    "subject": subject,
                    "body": param_text(params, "body"),
                    "task": task,
                }),
            )?;
            Ok(Value::Text(if resp.trim().is_empty() || resp.trim() == "ok" {
                "Message ajouté à la messagerie".into()
            } else {
                resp
            }))
        }
    );

    // ===================== FICHIERS =====================
    reg!(
        e,
        spec("list_files", "Lister les fichiers", "Liste les fichiers d'un dossier — un par ligne, « chemin — taille — créé — modifié », les dossiers finissant par « / ». À placer AVANT « Lire un fichier » quand le nom du fichier n'est pas connu d'avance. Mêmes règles de confinement que « Lire un fichier ».", "Fichiers", "folder-open",
            vec![
                p("path", "Dossier", ParamKind::Text).placeholder("Vide = racine, sinon notes/2026"),
                p("sandbox", "Sandbox (nom)", ParamKind::Text).placeholder("Nom d'une sandbox Lumen (optionnel)"),
                p("sandboxed", "Confiner à la sandbox", ParamKind::Bool),
                p("recursive", "Inclure les sous-dossiers", ParamKind::Bool),
            ], true),
        |params, ctx| {
            let recursive = param_value(params, "recursive").is_truthy();
            // 1) Sandbox nommée : passe par le pont Lumen (résolution nom → racine confinée).
            let sandbox = param_text(params, "sandbox");
            if !sandbox.is_empty() {
                let listing = crate::lumen::post_json("/sandbox/list", serde_json::json!({
                    "name": sandbox,
                    "path": param_text(params, "path"),
                    "recursive": recursive,
                }))?;
                return Ok(Value::Text(listing));
            }
            // 2) Sandbox de l'agent (option booléenne) ou chemin libre.
            let dir = resolve_file_path(params, ctx)?;
            // Garde-fous : une arborescence profonde ne doit ni faire tourner le
            // listage indéfiniment, ni noyer l'étape suivante du workflow.
            const MAX_ENTRIES: usize = 300;
            const MAX_DEPTH: usize = 4;
            let mut out: Vec<String> = Vec::new();
            let mut stack: Vec<(std::path::PathBuf, String, usize)> =
                vec![(dir.clone(), String::new(), 0)];
            'walk: while let Some((current, prefix, depth)) = stack.pop() {
                let Ok(entries) = std::fs::read_dir(&current) else { continue };
                for entry in entries.flatten() {
                    if out.len() >= MAX_ENTRIES {
                        out.push("… (liste tronquée)".into());
                        break 'walk;
                    }
                    let name = entry.file_name().to_string_lossy().to_string();
                    let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
                    let Ok(md) = entry.metadata() else { continue };
                    if md.is_dir() {
                        out.push(format!("{rel}/"));
                        if recursive && depth + 1 < MAX_DEPTH {
                            stack.push((entry.path(), rel, depth + 1));
                        }
                    } else {
                        out.push(format!(
                            "{rel} — {} o — créé {} — modifié {}",
                            md.len(),
                            stamp(md.created().ok()),
                            stamp(md.modified().ok())
                        ));
                    }
                }
            }
            out.sort();
            Ok(Value::Text(out.join("\n")))
        }
    );
    reg!(
        e,
        spec("read_file", "Lire un fichier", "Lit le contenu texte d'un fichier. Renseigner « Sandbox » lit dans la sandbox Lumen nommée (chemin relatif, confiné). Sinon, « Confiner à la sandbox » utilise la sandbox de l'agent courant ; à défaut, chemin libre.", "Fichiers", "file-text",
            vec![
                p("path", "Chemin", ParamKind::Text).required().placeholder("/chemin/fichier.txt ou notes/idee.md"),
                p("sandbox", "Sandbox (nom)", ParamKind::Text).placeholder("Nom d'une sandbox Lumen (optionnel)"),
                p("sandboxed", "Confiner à la sandbox", ParamKind::Bool),
            ], true),
        |params, ctx| {
            // 1) Sandbox nommée : passe par le pont Lumen (résolution nom → racine confinée).
            let sandbox = param_text(params, "sandbox");
            if !sandbox.is_empty() {
                let content = crate::lumen::post_json("/sandbox/read", serde_json::json!({
                    "name": sandbox,
                    "path": param_text(params, "path"),
                }))?;
                return Ok(Value::Text(content));
            }
            // 2) Sandbox de l'agent (option booléenne) ou chemin libre.
            let path = resolve_file_path(params, ctx)?;
            let content = std::fs::read_to_string(&path)
                .map_err(|e| anyhow::anyhow!("Lecture impossible : {e}"))?;
            Ok(Value::Text(content))
        }
    );
    reg!(
        e,
        spec("write_file", "Écrire un fichier", "Écrit du texte dans un fichier (écrase). Renseigner « Sandbox » écrit dans la sandbox Lumen nommée (chemin relatif, confiné, quota respecté). Sinon, « Confiner à la sandbox » utilise la sandbox de l'agent courant ; à défaut, chemin libre.", "Fichiers", "save",
            vec![
                p("path", "Chemin", ParamKind::Text).required(),
                p("content", "Contenu", ParamKind::Multiline).placeholder("{{input}}"),
                p("sandbox", "Sandbox (nom)", ParamKind::Text).placeholder("Nom d'une sandbox Lumen (optionnel)"),
                p("sandboxed", "Confiner à la sandbox", ParamKind::Bool),
            ], true),
        |params, ctx| {
            let content = param_text(params, "content");
            // 1) Sandbox nommée : pont Lumen (écriture confinée, quota vérifié côté hôte).
            let sandbox = param_text(params, "sandbox");
            if !sandbox.is_empty() {
                crate::lumen::post_json("/sandbox/write", serde_json::json!({
                    "name": sandbox,
                    "path": param_text(params, "path"),
                    "content": content,
                }))?;
                return Ok(Value::Bool(true));
            }
            // 2) Sandbox de l'agent (option booléenne) ou chemin libre.
            let path = resolve_file_path(params, ctx)?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            std::fs::write(&path, &content).map_err(|e| anyhow::anyhow!("Écriture impossible : {e}"))?;
            Ok(Value::File(path.to_string_lossy().to_string()))
        }
    );

    // ===================== BASES DE DONNÉES =====================
    // Sécurité : les valeurs passent **toujours** par des paramètres liés
    // (positionnels) — jamais concaténées dans le SQL — ce qui neutralise
    // l'injection. Le nombre de lignes lues est plafonné (mémoire). Pour SQLite,
    // l'option « Confiner à la sandbox » cantonne le fichier à la sandbox active.
    reg!(
        e,
        spec("sqlite_query", "Requête SQLite", "Exécute une requête sur une base SQLite. Les valeurs vont dans « Paramètres » (tableau JSON) et sont liées via ? — ne jamais concaténer de saisie dans le SQL. SELECT → lignes (JSON) ; sinon → nombre de lignes affectées.", "Données", "list",
            vec![
                p("path", "Fichier .sqlite", ParamKind::Text).required().placeholder("/chemin/base.sqlite ou data/app.db"),
                p("query", "Requête SQL", ParamKind::Multiline).required().placeholder("SELECT * FROM users WHERE age > ?"),
                p("params", "Paramètres (tableau JSON)", ParamKind::Text).placeholder("[18]"),
                p("limit", "Lignes max", ParamKind::Number).placeholder("1000 (défaut)"),
                p("sandboxed", "Confiner à la sandbox", ParamKind::Bool),
            ], true),
        |params, ctx| {
            let path = {
                // Réutilise la résolution confinée des actions fichiers.
                resolve_file_path(params, ctx)?
            };
            let query = param_text(params, "query");
            if query.trim().is_empty() { anyhow::bail!("Requête SQL vide"); }
            let limit = sql_limit(param_num(params, "limit"));
            let binds = sql_parse_params(&param_text(params, "params"))?;
            run_sqlite(&path, &query, &binds, limit)
        }
    );
    reg!(
        e,
        spec("postgres_query", "Requête PostgreSQL", "Exécute une requête sur PostgreSQL. Les valeurs vont dans « Paramètres » (tableau JSON) et sont liées via $1, $2… — ne jamais concaténer de saisie dans le SQL. SELECT → lignes (JSON) ; sinon → nombre de lignes affectées.", "Données", "globe",
            vec![
                p("conn", "Connexion", ParamKind::Text).required().placeholder("host=localhost user=postgres password=… dbname=app"),
                p("query", "Requête SQL", ParamKind::Multiline).required().placeholder("SELECT id, nom FROM clients WHERE actif = $1"),
                p("params", "Paramètres (tableau JSON)", ParamKind::Text).placeholder("[true]"),
                p("limit", "Lignes max", ParamKind::Number).placeholder("1000 (défaut)"),
            ], true),
        |params, _ctx| {
            let conn = param_text(params, "conn");
            if conn.trim().is_empty() { anyhow::bail!("Chaîne de connexion vide"); }
            let query = param_text(params, "query");
            if query.trim().is_empty() { anyhow::bail!("Requête SQL vide"); }
            let limit = sql_limit(param_num(params, "limit"));
            let binds = sql_parse_params(&param_text(params, "params"))?;
            run_postgres(&conn, &query, &binds, limit)
        }
    );

    // ===================== MACHINE LEARNING =====================
    // Applique un modèle entraîné par l'app « Atelier ML » (format JSON à
    // couches). Tabulaire/images : pur calcul Rust (passe avant + activations).
    // Modèles TEXTE (`input: "text"`) : l'entrée est une phrase dont l'embedding
    // est demandé à Lumen (`POST /ml/embed` → worker transformers.js de la
    // fenêtre principale) avant la passe avant — le backend n'a pas de runtime ML.
    reg!(
        e,
        spec("ml_predict", "Prédire (ML)", "Applique un modèle « Atelier ML » (JSON) à des features (ou une phrase pour un modèle texte) et renvoie la prédiction.", "Machine Learning", "share-2",
            vec![
                p("model", "Modèle (JSON)", ParamKind::Multiline).required().placeholder("{{modele}} ou contenu du .mlmodel.json"),
                p("features", "Entrées", ParamKind::Text).required().placeholder("1.0, 2.5, 3 — ou une phrase (modèle texte) — ou {{input}}"),
                p("detail", "Sortie détaillée (label + score + probabilités)", ParamKind::Bool),
            ], true),
        |params, _ctx| {
            let model: serde_json::Value = serde_json::from_str(param_text(params, "model").trim())
                .map_err(|e| anyhow::anyhow!("Modèle JSON invalide : {e}"))?;
            let raw = param_text(params, "features");
            let feats = if model.get("input").and_then(|v| v.as_str()) == Some("text") {
                ml_embed_text(&model, raw.trim())?
            } else {
                ml_parse_feats(&raw)
            };
            let detail = matches!(params.get("detail"), Some(Value::Bool(true)))
                || matches!(param_text(params, "detail").trim().to_lowercase().as_str(), "true" | "1" | "oui");
            ml_predict_value(&model, &feats, detail)
        }
    );

    // ===================== DOMOTIQUE LUMEN =====================
    // Contrôle des objets enregistrés dans Lumen via le serveur loopback. Le
    // moteur Fluxo reste indépendant de Tauri : Lumen fournit la résolution des
    // objets et la signature HMAC côté backend.
    register_domotique(e);
    // Blocs des apps de Lumen (outils natifs + App Intents des paquets).
    lumen_apps::register_lumen_apps(e);

    // ===================== RASPBERRY PI (feature `rpi`) =====================
    // Blocs matériels (GPIO/PWM/I²C/série) via `pigs` (client pigpiod) + infos
    // système. Présents uniquement dans le build Raspberry Pi.
    #[cfg(feature = "rpi")]
    register_rpi(e);
}

// ---------- Inférence ML (passe avant d'un modèle « Atelier ML ») ----------
fn ml_parse_feats(s: &str) -> Vec<f64> {
    let t = s.trim();
    if let Ok(serde_json::Value::Array(a)) = serde_json::from_str::<serde_json::Value>(t) {
        return a
            .iter()
            .map(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.trim().replace(',', ".").parse().ok()))
                    .unwrap_or(0.0)
            })
            .collect();
    }
    t.split(|c| c == ',' || c == ';' || c == ' ' || c == '\n' || c == '\t')
        .filter(|x| !x.trim().is_empty())
        .map(|x| x.trim().parse().unwrap_or(0.0))
        .collect()
}

fn ml_activate(z: &[f64], kind: &str) -> Vec<f64> {
    match kind {
        "relu" => z.iter().map(|&x| x.max(0.0)).collect(),
        "sigmoid" => z.iter().map(|&x| 1.0 / (1.0 + (-x).exp())).collect(),
        "tanh" => z.iter().map(|&x| x.tanh()).collect(),
        "softmax" => {
            let m = z.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let e: Vec<f64> = z.iter().map(|&x| (x - m).exp()).collect();
            let s: f64 = e.iter().sum();
            e.iter().map(|&x| x / if s == 0.0 { 1.0 } else { s }).collect()
        }
        _ => z.to_vec(),
    }
}

/// Embedding d'une phrase pour un modèle texte de l'Atelier ML : délégué à la
/// fenêtre principale de Lumen via le loopback (`/ml/embed`). Applique le
/// préfixe `query:` des modèles E5 (même préparation qu'à l'entraînement).
fn ml_embed_text(model: &serde_json::Value, text: &str) -> anyhow::Result<Vec<f64>> {
    if text.is_empty() {
        anyhow::bail!("Entrée vide : un modèle texte attend une phrase à classer");
    }
    let embed_model = model
        .get("embedModel")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Modèle texte sans 'embedModel'"))?;
    let prefixed = if model
        .get("e5QueryPrefix")
        .and_then(|v| v.as_bool())
        .unwrap_or_else(|| embed_model.to_lowercase().contains("e5"))
    {
        format!("query: {text}")
    } else {
        text.to_string()
    };
    // Délai large : au premier appel Lumen peut devoir télécharger le modèle
    // d'embeddings avant de répondre.
    let body = crate::lumen::post_json_timeout(
        "/ml/embed",
        serde_json::json!({ "model": embed_model, "text": prefixed }),
        180,
    )
    .map_err(|e| anyhow::anyhow!("Embedding indisponible (fenêtre Lumen ouverte ?) : {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&body)?;
    let emb = v
        .get("embedding")
        .and_then(|a| a.as_array())
        .ok_or_else(|| anyhow::anyhow!("Réponse embedding invalide"))?;
    Ok(emb.iter().filter_map(|x| x.as_f64()).collect())
}

fn ml_predict_value(model: &serde_json::Value, feats: &[f64], detail: bool) -> anyhow::Result<Value> {
    let mean = model.get("mean").and_then(|v| v.as_array());
    let std = model.get("std").and_then(|v| v.as_array());
    let mut a: Vec<f64> = feats
        .iter()
        .enumerate()
        .map(|(i, &x)| {
            let m = mean.and_then(|m| m.get(i)).and_then(|v| v.as_f64()).unwrap_or(0.0);
            let s = std.and_then(|s| s.get(i)).and_then(|v| v.as_f64()).unwrap_or(1.0);
            if s != 0.0 { (x - m) / s } else { x - m }
        })
        .collect();

    let layers = model
        .get("layers")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("Modèle sans 'layers'"))?;
    for layer in layers {
        let w = layer
            .get("w")
            .and_then(|v| v.as_array())
            .ok_or_else(|| anyhow::anyhow!("Couche sans 'w'"))?;
        let b = layer.get("b").and_then(|v| v.as_array());
        let actk = layer.get("act").and_then(|v| v.as_str()).unwrap_or("linear");
        let mut z: Vec<f64> = Vec::with_capacity(w.len());
        for (j, row) in w.iter().enumerate() {
            let row = row.as_array().ok_or_else(|| anyhow::anyhow!("'w' mal formé"))?;
            let mut s = b.and_then(|b| b.get(j)).and_then(|v| v.as_f64()).unwrap_or(0.0);
            for (i, wij) in row.iter().enumerate() {
                s += wij.as_f64().unwrap_or(0.0) * a.get(i).copied().unwrap_or(0.0);
            }
            z.push(s);
        }
        a = ml_activate(&z, actk);
    }

    let task = model.get("task").and_then(|v| v.as_str()).unwrap_or("regression");
    if task == "regression" {
        let ymean = model.get("ymean").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let ystd = model.get("ystd").and_then(|v| v.as_f64()).unwrap_or(1.0);
        Ok(Value::Number(a.first().copied().unwrap_or(0.0) * ystd + ymean))
    } else {
        let classes: Vec<String> = model
            .get("classes")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().map(|c| c.as_str().unwrap_or("").to_string()).collect())
            .unwrap_or_default();
        // Probabilités par classe : sortie sigmoïde binaire → [1-p, p] ; softmax
        // multi-classes → telle quelle.
        let probs: Vec<f64> = if a.len() == 1 { vec![1.0 - a[0], a[0]] } else { a.clone() };
        let mut idx = 0;
        let mut best = f64::NEG_INFINITY;
        for (i, &x) in probs.iter().enumerate() {
            if x > best { best = x; idx = i; }
        }
        let name_of = |i: usize| classes.get(i).cloned().unwrap_or_else(|| i.to_string());
        let label = name_of(idx);
        if !detail {
            return Ok(Value::Text(label));
        }
        // Sortie détaillée : le score de la classe prédite + toutes les
        // probabilités, exploitables en aval via {{bloc.label}} / {{bloc.score}}.
        let mut out = std::collections::BTreeMap::new();
        out.insert("label".to_string(), Value::Text(label));
        out.insert("score".to_string(), Value::Number(best));
        let mut pmap = std::collections::BTreeMap::new();
        for (i, &pr) in probs.iter().enumerate() {
            pmap.insert(name_of(i), Value::Number(pr));
        }
        out.insert("probs".to_string(), Value::Dict(pmap));
        Ok(Value::Dict(out))
    }
}

/// Analyse le champ « Choix » d'une notification Lumen : une option par ligne.
/// Format `id | Libellé` (ou juste `Libellé`, l'id étant alors dérivé). Une ligne
/// préfixée de `*` marque le bouton **principal**. Renvoie le tableau d'objets
/// `{id, label, primary}` attendu par `/notify`.
fn parse_notification_actions(raw: &str) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut line = line.trim();
        if line.is_empty() {
            continue;
        }
        let primary = line.starts_with('*');
        if primary {
            line = line[1..].trim_start();
        }
        let (id, label) = match line.split_once('|') {
            Some((a, b)) => (a.trim().to_string(), b.trim().to_string()),
            None => {
                let label = line.to_string();
                // id dérivé : minuscules, espaces → « _ ».
                let id = label
                    .to_lowercase()
                    .chars()
                    .map(|c| if c.is_alphanumeric() { c } else { '_' })
                    .collect::<String>();
                (id, label)
            }
        };
        if label.is_empty() {
            continue;
        }
        out.push(serde_json::json!({ "id": id, "label": label, "primary": primary }));
    }
    out
}

/// Analyse le champ « Headers » des blocs HTTP.
///
/// Formats acceptés :
/// - une ligne par header : `Authorization: Bearer xxx`
/// - un objet JSON : `{ "Authorization": "Bearer xxx", "Accept": "application/json" }`
fn parse_http_headers(raw: &str) -> anyhow::Result<reqwest::header::HeaderMap> {
    use reqwest::header::HeaderMap;

    let mut headers = HeaderMap::new();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(headers);
    }

    if trimmed.starts_with('{') {
        let value: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|e| anyhow::anyhow!("Headers JSON invalides : {e}"))?;
        let object = value
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("Headers doit être un objet JSON"))?;
        for (name, value) in object {
            let value = match value {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                serde_json::Value::Null => continue,
                _ => anyhow::bail!("Header {name} invalide : valeur scalaire attendue"),
            };
            insert_http_header(&mut headers, name, &value)?;
        }
        return Ok(headers);
    }

    for (idx, line) in raw.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("Header ligne {} invalide : utilisez « Nom: valeur »", idx + 1))?;
        insert_http_header(&mut headers, name.trim(), value.trim())?;
    }
    Ok(headers)
}

fn insert_http_header(
    headers: &mut reqwest::header::HeaderMap,
    name: &str,
    value: &str,
) -> anyhow::Result<()> {
    let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
        .map_err(|e| anyhow::anyhow!("Nom de header invalide « {name} » : {e}"))?;
    let value = reqwest::header::HeaderValue::from_str(value)
        .map_err(|e| anyhow::anyhow!("Valeur invalide pour le header « {name} » : {e}"))?;
    headers.insert(name, value);
    Ok(())
}

// ===================== Bases de données (helpers) =====================

const SQL_MAX_ROWS: usize = 1000;

/// Plafonne le nombre de lignes lues (0/négatif/au-delà du max ⇒ max).
fn sql_limit(n: f64) -> usize {
    let n = n as i64;
    if n <= 0 || n as usize > SQL_MAX_ROWS {
        SQL_MAX_ROWS
    } else {
        n as usize
    }
}

/// Analyse le champ « Paramètres » : un tableau JSON (`[1, "x", true]`) ou vide.
/// Tout sauf un tableau est refusé (évite les surprises de typage).
fn sql_parse_params(raw: &str) -> anyhow::Result<Vec<serde_json::Value>> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<serde_json::Value>(t) {
        Ok(serde_json::Value::Array(a)) => Ok(a),
        Ok(_) => anyhow::bail!("« Paramètres » doit être un tableau JSON, ex. [18, \"actif\"]"),
        Err(e) => anyhow::bail!("Paramètres JSON invalides : {e}"),
    }
}

/// Vrai si la requête renvoie des lignes (SELECT/WITH/VALUES/EXPLAIN/PRAGMA/TABLE/SHOW).
fn sql_is_read(query: &str) -> bool {
    let head = query.trim_start().split_whitespace().next().unwrap_or("").to_ascii_uppercase();
    matches!(head.as_str(), "SELECT" | "WITH" | "VALUES" | "EXPLAIN" | "PRAGMA" | "TABLE" | "SHOW")
}

fn run_sqlite(
    path: &std::path::Path,
    query: &str,
    binds: &[serde_json::Value],
    limit: usize,
) -> anyhow::Result<Value> {
    use rusqlite::types::{Value as SqlV, ValueRef};
    // Liaison positionnelle : aucune valeur n'est interpolée dans le SQL.
    let sql_params: Vec<SqlV> = binds.iter().map(json_to_sqlite).collect();
    let conn = rusqlite::Connection::open(path)
        .map_err(|e| anyhow::anyhow!("Ouverture SQLite impossible : {e}"))?;

    if !sql_is_read(query) {
        let n = conn
            .execute(query, rusqlite::params_from_iter(sql_params.iter()))
            .map_err(|e| anyhow::anyhow!("Échec SQL : {e}"))?;
        let mut d = BTreeMap::new();
        d.insert("rows_affected".into(), Value::Number(n as f64));
        return Ok(Value::Dict(d));
    }

    let mut stmt = conn.prepare(query).map_err(|e| anyhow::anyhow!("SQL invalide : {e}"))?;
    let col_count = stmt.column_count();
    let cols: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(sql_params.iter()))
        .map_err(|e| anyhow::anyhow!("Échec SQL : {e}"))?;
    let mut out: Vec<Value> = Vec::new();
    while let Some(r) = rows.next().map_err(|e| anyhow::anyhow!("{e}"))? {
        let mut obj = BTreeMap::new();
        for i in 0..col_count {
            let v = match r.get_ref(i).map_err(|e| anyhow::anyhow!("{e}"))? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => Value::Number(n as f64),
                ValueRef::Real(f) => Value::Number(f),
                ValueRef::Text(t) => Value::Text(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(b) => Value::Text(format!("<blob {} octets>", b.len())),
            };
            obj.insert(cols[i].clone(), v);
        }
        out.push(Value::Dict(obj));
        if out.len() >= limit {
            break;
        }
    }
    Ok(Value::List(out))
}

/// Convertit une valeur JSON en valeur SQLite typée (liaison sûre).
fn json_to_sqlite(v: &serde_json::Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as S;
    match v {
        serde_json::Value::Null => S::Null,
        serde_json::Value::Bool(b) => S::Integer(if *b { 1 } else { 0 }),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                S::Integer(i)
            } else {
                S::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => S::Text(s.clone()),
        // Objets/tableaux : liés comme texte JSON.
        other => S::Text(other.to_string()),
    }
}

fn run_postgres(
    conn_str: &str,
    query: &str,
    binds: &[serde_json::Value],
    limit: usize,
) -> anyhow::Result<Value> {
    use postgres::types::ToSql;
    // NoTls : connexion non chiffrée (adaptée à un Postgres local). Pour un serveur
    // distant, privilégier un tunnel/proxy TLS — la chaîne de connexion n'active
    // pas TLS ici.
    let mut client = postgres::Client::connect(conn_str, postgres::NoTls)
        .map_err(|e| anyhow::anyhow!("Connexion PostgreSQL impossible : {e}"))?;

    // Paramètres liés positionnellement ($1, $2…), jamais concaténés.
    let boxed: Vec<Box<dyn ToSql + Sync>> = binds.iter().map(json_to_pg).collect();
    let refs: Vec<&(dyn ToSql + Sync)> = boxed.iter().map(|b| b.as_ref()).collect();

    if !sql_is_read(query) {
        let n = client
            .execute(query, &refs)
            .map_err(|e| anyhow::anyhow!("Échec SQL : {e}"))?;
        let mut d = BTreeMap::new();
        d.insert("rows_affected".into(), Value::Number(n as f64));
        return Ok(Value::Dict(d));
    }

    // Enveloppe la requête pour récupérer chaque ligne en JSON (gère tous les
    // types Postgres de façon générique), avec un plafond de lignes.
    let wrapped = format!("SELECT to_jsonb(_sub) FROM ( {} ) AS _sub LIMIT {}", query, limit);
    let rows = client
        .query(wrapped.as_str(), &refs)
        .map_err(|e| anyhow::anyhow!("Échec SQL : {e}"))?;
    let mut out: Vec<Value> = Vec::with_capacity(rows.len());
    for row in &rows {
        let j: serde_json::Value = row.get(0);
        out.push(crate::value::json_to_value(&j));
    }
    Ok(Value::List(out))
}

/// Convertit une valeur JSON en paramètre PostgreSQL typé (liaison sûre).
fn json_to_pg(v: &serde_json::Value) -> Box<dyn postgres::types::ToSql + Sync> {
    match v {
        serde_json::Value::Null => Box::new(Option::<String>::None),
        serde_json::Value::Bool(b) => Box::new(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else {
                Box::new(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => Box::new(s.clone()),
        // Objets/tableaux : transmis comme JSON (jsonb/json côté serveur).
        other => Box::new(other.clone()),
    }
}

/// Résout le chemin d'une action fichier. Si l'option « Confiner à la sandbox »
/// est active, exige qu'une racine de sandbox soit présente dans le contexte et
/// résout le chemin **confiné** à cette racine ; sinon, chemin libre (comportement
/// historique).
/// Date lisible (`2026-09-04 09:12`) pour le listage de fichiers. Vide si le
/// système de fichiers ne tient pas l'horodatage demandé.
fn stamp(t: Option<std::time::SystemTime>) -> String {
    t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0))
        .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

fn resolve_file_path(
    params: &BTreeMap<String, Value>,
    ctx: &ExecContext,
) -> anyhow::Result<std::path::PathBuf> {
    let path = param_text(params, "path");
    if param_value(params, "sandboxed").is_truthy() {
        let root = ctx.sandbox_root.as_ref().ok_or_else(|| {
            anyhow::anyhow!(
                "Confinement demandé mais aucune sandbox active : exécute ce workflow via un agent doté d'une sandbox."
            )
        })?;
        crate::action::confine_path(root, &path).map_err(|e| anyhow::anyhow!(e))
    } else {
        let p = std::path::PathBuf::from(path);
        if crate::is_protected_path(&p) {
            anyhow::bail!("Accès refusé : ce dossier contient la configuration privée de Lumen (clés, jetons).");
        }
        Ok(p)
    }
}

// ===================== Helpers =====================

/// Résout le `run_id` à associer aux retours Lumen, par ordre de priorité :
///   1. le paramètre explicite du bloc (typiquement `{{run_id}}`, déjà interpolé) ;
///   2. la variable de contexte `run_id` pré-amorcée par l'hôte (Lumen) ;
///   3. le repli `crate::lumen::run_id()` (variable d'env `FLUXO_RUN_ID`, sinon « fluxo »).
fn resolve_run_id(params: &BTreeMap<String, Value>, ctx: &ExecContext) -> String {
    let p = param_text(params, "run_id");
    if !p.is_empty() {
        return p;
    }
    if let Some(v) = ctx.vars.get("run_id") {
        let s = v.as_text();
        if !s.is_empty() {
            return s;
        }
    }
    crate::lumen::run_id()
}

fn parse_json_object(raw: &str) -> anyhow::Result<serde_json::Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::json!({}));
    }
    let v: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|e| anyhow::anyhow!("JSON invalide : {e}"))?;
    if !v.is_object() {
        anyhow::bail!("Les paramètres doivent être un objet JSON");
    }
    Ok(v)
}

fn parse_matrix8_pixels(raw: &str) -> anyhow::Result<Vec<serde_json::Value>> {
    let trimmed = raw.trim();
    let mut pixels = Vec::new();
    if trimmed.is_empty() {
        pixels.resize(64, serde_json::Value::Null);
        return Ok(pixels);
    }

    if let Ok(serde_json::Value::Array(arr)) = serde_json::from_str::<serde_json::Value>(trimmed) {
        for v in arr.into_iter().take(64) {
            pixels.push(normalize_matrix_pixel(v));
        }
    } else {
        for row in trimmed.lines().map(str::trim).filter(|l| !l.is_empty()).take(8) {
            for ch in row.chars().take(8) {
                pixels.push(if ch == '.' || ch == '0' {
                    serde_json::Value::Null
                } else {
                    serde_json::Value::String("#40b4ff".into())
                });
            }
            while pixels.len() % 8 != 0 {
                pixels.push(serde_json::Value::Null);
            }
        }
    }

    if pixels.is_empty() {
        anyhow::bail!("Dessin matrice invalide : attendu JSON de 64 pixels ou motif texte 8 lignes");
    }
    pixels.resize(64, serde_json::Value::Null);
    Ok(pixels)
}

fn normalize_matrix_pixel(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::String(s) if is_hex_color(&s) => serde_json::Value::String(s),
        serde_json::Value::Array(rgb) if rgb.len() >= 3 => {
            let nums: Vec<u8> = rgb
                .iter()
                .take(3)
                .map(|n| n.as_u64().unwrap_or(0).min(255) as u8)
                .collect();
            serde_json::Value::String(format!("#{:02x}{:02x}{:02x}", nums[0], nums[1], nums[2]))
        }
        _ => serde_json::Value::Null,
    }
}

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn post_lumen_json(path: &str, body: serde_json::Value) -> anyhow::Result<String> {
    let endpoint = format!("http://127.0.0.1:8765{path}");
    reqwest::blocking::Client::new()
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body)?)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| anyhow::anyhow!("Lumen loopback injoignable ({endpoint}) : {e}"))
}

fn get_lumen(path: &str) -> anyhow::Result<String> {
    let endpoint = format!("http://127.0.0.1:8765{path}");
    reqwest::blocking::get(&endpoint)
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| anyhow::anyhow!("Lumen loopback injoignable ({endpoint}) : {e}"))
}

pub fn register_domotique(e: &mut Engine) {
    const CAT: &str = "Domotique";

    reg!(
        e,
        spec("domotique_devices", "Domotique : lister les objets", "Renvoie les objets connectés enregistrés dans Lumen (sans les clés secrètes).", CAT, "house",
            vec![], true),
        |_params, _ctx| {
            Ok(Value::Text(get_lumen("/domotique/devices")?))
        }
    );
    reg!(
        e,
        spec("domotique_state", "Domotique : lire l'état", "Lit l'état d'un objet par nom ou id via le protocole local sécurisé.", CAT, "activity",
            vec![p("device", "Objet", ParamKind::Text).required().placeholder("Lampe salon ou dev-1234")], true),
        |params, _ctx| {
            let device = param_text(params, "device");
            if device.trim().is_empty() { anyhow::bail!("Objet manquant"); }
            Ok(Value::Text(post_lumen_json("/domotique/state", serde_json::json!({ "device": device }))?))
        }
    );
    reg!(
        e,
        spec("domotique_cmd", "Domotique : commander", "Envoie une commande à un objet par nom ou id. Action courante : set, toggle, pulse, read selon le firmware.", CAT, "zap",
            vec![
                p("device", "Objet", ParamKind::Text).required().placeholder("Lampe salon"),
                p("action", "Action", ParamKind::Text).placeholder("set, toggle…"),
                p("params", "Paramètres JSON", ParamKind::Multiline).placeholder("{\"on\":true,\"brightness\":80}"),
            ], true),
        |params, _ctx| {
            let device = param_text(params, "device");
            if device.trim().is_empty() { anyhow::bail!("Objet manquant"); }
            let action = {
                let a = param_text(params, "action");
                if a.trim().is_empty() { "set".into() } else { a }
            };
            let body = serde_json::json!({
                "device": device,
                "action": action,
                "params": parse_json_object(&param_text(params, "params"))?,
            });
            Ok(Value::Text(post_lumen_json("/domotique/cmd", body)?))
        }
    );
    reg!(
        e,
        spec("domotique_matrix8_draw", "Domotique : dessiner matrice 8x8", "Envoie un dessin pixel par pixel vers une matrice LED 8x8 Lumen.", CAT, "layout",
            vec![
                p("device", "Objet", ParamKind::Text).required().placeholder("Matrix salon"),
                p("component", "Composant", ParamKind::Text).placeholder("matrix8_14 ou laisser vide si objet simple"),
                p("pixels", "Dessin", ParamKind::Matrix8),
            ], true),
        |params, _ctx| {
            let device = param_text(params, "device");
            if device.trim().is_empty() { anyhow::bail!("Objet manquant"); }
            let component = param_text(params, "component");
            let pixels = parse_matrix8_pixels(&param_text(params, "pixels"))?;
            let mut body = serde_json::json!({
                "device": device,
                "action": "draw",
                "params": { "pixels": pixels },
            });
            if !component.trim().is_empty() {
                body["component"] = serde_json::Value::String(component);
            }
            Ok(Value::Text(post_lumen_json("/domotique/cmd", body)?))
        }
    );
}

/// Interroge l'API `/api/generate` d'Ollama (non-stream) et renvoie le champ
/// `response`. `system` est omis s'il est vide. Sérialisation manuelle car la
/// feature `json` de reqwest n'est pas activée.
/// Backend LLM global actif (poussé par Lumen via variables d'env avant l'exécution
/// d'un workflow) : `Some((base, key, model_override))` si le mode « API cloud »
/// (OpenAI-compatible) est actif, sinon `None` (→ Ollama natif).
fn llm_api_override() -> Option<(String, String, String)> {
    let backend = std::env::var("LUMEN_LLM_BACKEND").unwrap_or_default();
    if backend != "api" && backend != "llama" {
        return None;
    }
    let key = crate::host_api_key();
    if backend == "api" && key.is_empty() {
        return None;
    }
    let base = std::env::var("LUMEN_LLM_API_BASE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.openai.com/v1".into());
    let model = std::env::var("LUMEN_LLM_API_MODEL").unwrap_or_default();
    Some((base, key, model))
}

/// Base OpenAI-compatible du llama-server local de Lumen. `LUMEN_LLM_API_BASE`
/// la porte déjà quand la source active est llama.cpp ; sinon on retombe sur le
/// port fixe du serveur (11435), celui que Lumen démarre lui-même.
fn llama_base_url() -> String {
    if std::env::var("LUMEN_LLM_BACKEND").unwrap_or_default() == "llama" {
        if let Ok(base) = std::env::var("LUMEN_LLM_API_BASE") {
            if !base.is_empty() {
                return base;
            }
        }
    }
    "http://127.0.0.1:11435/v1".to_string()
}

/// Demande à Lumen de démarrer llama-server sur ce modèle (best-effort).
///
/// Le moteur n'a pas accès aux commandes Tauri : il passe par le serveur
/// loopback, comme les blocs de retour. Sans Lumen (exécution autonome), l'appel
/// échoue en silence et la requête qui suit produira l'erreur utile — un serveur
/// déjà lancé sur le bon modèle répond parfaitement sans cette étape.
fn ensure_llama_model(model: &str) {
    let _ = crate::lumen::post_json_timeout(
        "/llama/ensure",
        serde_json::json!({ "model": model }),
        180,
    );
}

/// Appel OpenAI-compatible `/chat/completions` (non-stream) → contenu assistant.
fn openai_chat(base: &str, key: &str, model: &str, messages: &[serde_json::Value]) -> anyhow::Result<String> {
    openai_chat_configured(base, key, model, messages, false, 0)
}

fn openai_chat_configured(base: &str, key: &str, model: &str, messages: &[serde_json::Value], think: bool, context_size: u64) -> anyhow::Result<String> {
    let mut body = serde_json::json!({ "model": model, "messages": messages, "stream": false });
    // Champs optionnels : les serveurs OpenAI-compatibles qui ne les connaissent
    // peuvent les ignorer ; Ollama reçoit ses options via sa route dédiée.
    if think { body["reasoning_effort"] = serde_json::Value::String("high".into()); }
    if context_size > 0 { body["max_context_tokens"] = serde_json::json!(context_size); }
    let endpoint = format!("{}/chat/completions", base.trim_end_matches('/'));
    let resp = reqwest::blocking::Client::new()
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {key}"))
        .body(serde_json::to_string(&body)?)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| anyhow::anyhow!("API IA injoignable ({endpoint}) : {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&resp).map_err(|e| anyhow::anyhow!("Réponse API invalide : {e}"))?;
    Ok(parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

fn normalize_ollama_url(url: &str) -> String {
    let value = url.trim().trim_end_matches('/');
    let value = if value.is_empty() { "http://127.0.0.1:11434" } else { value };
    value.replace("://localhost", "://127.0.0.1")
}

fn ollama_generate(url: &str, model: &str, prompt: &str, system: &str) -> anyhow::Result<String> {
    ollama_generate_configured(url, model, prompt, system, false, 0)
}

fn ollama_generate_configured(url: &str, model: &str, prompt: &str, system: &str, think: bool, context_size: u64) -> anyhow::Result<String> {
    // Bascule globale vers l'API cloud (OpenAI-compatible) si Lumen l'a activée.
    if let Some((base, key, m)) = llm_api_override() {
        let model = if m.is_empty() { model } else { &m };
        let mut msgs: Vec<serde_json::Value> = Vec::new();
        if !system.is_empty() {
            msgs.push(serde_json::json!({ "role": "system", "content": system }));
        }
        msgs.push(serde_json::json!({ "role": "user", "content": prompt }));
        return openai_chat(&base, &key, model, &msgs);
    }
    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
    });
    if !system.is_empty() {
        body["system"] = serde_json::Value::String(system.to_string());
    }
    if think { body["think"] = serde_json::Value::Bool(true); }
    if context_size > 0 { body["options"] = serde_json::json!({ "num_ctx": context_size }); }
    let endpoint = format!("{}/api/generate", normalize_ollama_url(url));
    let payload = serde_json::to_string(&body)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()?;
    let mut last_error = None;
    let mut response = None;
    for attempt in 0..2 {
        match client.post(&endpoint).header("Content-Type", "application/json")
            .body(payload.clone()).send().and_then(|r| r.error_for_status()).and_then(|r| r.text()) {
            Ok(text) => { response = Some(text); break; }
            Err(error) => {
                last_error = Some(error);
                if attempt == 0 { std::thread::sleep(std::time::Duration::from_millis(900)); }
            }
        }
    }
    let resp = response.ok_or_else(|| anyhow::anyhow!(
        "Ollama injoignable ({endpoint}) après une nouvelle tentative : {}",
        last_error.map(|e| e.to_string()).unwrap_or_else(|| "erreur inconnue".into())
    ))?;
    let parsed: serde_json::Value = serde_json::from_str(&resp)
        .map_err(|e| anyhow::anyhow!("Réponse Ollama invalide : {e}"))?;
    Ok(parsed
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// Interroge l'API `/api/chat` d'Ollama (non-stream) avec une liste de messages
/// `[{role, content}, …]` et renvoie le contenu du message de l'assistant.
fn ollama_chat(url: &str, model: &str, messages: &[serde_json::Value]) -> anyhow::Result<String> {
    if let Some((base, key, m)) = llm_api_override() {
        let model = if m.is_empty() { model } else { &m };
        return openai_chat(&base, &key, model, messages);
    }
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    let endpoint = format!("{}/api/chat", normalize_ollama_url(url));
    let resp = reqwest::blocking::Client::new()
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body)?)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| anyhow::anyhow!("Ollama injoignable ({endpoint}) : {e}"))?;
    let parsed: serde_json::Value = serde_json::from_str(&resp)
        .map_err(|e| anyhow::anyhow!("Réponse Ollama invalide : {e}"))?;
    Ok(parsed
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

fn run_shell(command: &str) -> anyhow::Result<Value> {
    if command.trim().is_empty() {
        anyhow::bail!("Commande vide");
    }
    let output = if cfg!(target_os = "windows") {
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", command]);
        hide_console_window(&mut cmd);
        cmd.env_remove("LUMEN_LLM_API_KEY");
        cmd.output()
    } else {
        // Ceinture et bretelles : la clé n'est plus dans l'environnement, mais
        // on l'ôte quand même d'un environnement hérité d'une ancienne version.
        std::process::Command::new("sh").args(["-c", command]).env_remove("LUMEN_LLM_API_KEY").output()
    }
    .map_err(|e| anyhow::anyhow!("Lancement impossible : {e}"))?;

    if output.status.success() {
        Ok(Value::Text(String::from_utf8_lossy(&output.stdout).trim_end().to_string()))
    } else {
        anyhow::bail!("{}", String::from_utf8_lossy(&output.stderr).trim_end().to_string())
    }
}

fn open_path(target: &str) -> anyhow::Result<()> {
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(target).status()
    } else if cfg!(target_os = "windows") {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", target]);
        hide_console_window(&mut cmd);
        cmd.status()
    } else {
        std::process::Command::new("xdg-open").arg(target).status()
    }
    .map_err(|e| anyhow::anyhow!("Ouverture impossible : {e}"))?;
    if status.success() { Ok(()) } else { anyhow::bail!("Échec de l'ouverture") }
}

#[derive(Default)]
struct SystemSpeechState {
    last_text: String,
    last_finished: Option<Instant>,
}

static SYSTEM_SPEECH: OnceLock<Mutex<SystemSpeechState>> = OnceLock::new();
/// Processus de lecture vocale en cours (say / PowerShell / spd-say). Permet de
/// l'interrompre depuis l'UI (bouton 🔊 du chat qui bascule lecture/arrêt).
static SYSTEM_SPEECH_CHILD: OnceLock<Mutex<Option<std::process::Child>>> = OnceLock::new();

/// Interrompt immédiatement la lecture vocale système en cours, le cas échéant.
pub fn stop_system_speech() {
    if let Some(slot) = SYSTEM_SPEECH_CHILD.get() {
        if let Ok(mut guard) = slot.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Lit un texte avec la synthèse vocale système, sans permettre à deux fenêtres ou
/// workflows de lancer `say` en parallèle. Renvoie `false` si une lecture est déjà
/// en cours ou si le même texte vient d'être lu.
pub fn strip_markdown_for_speech(input: &str) -> String {
    let mut text = input.replace("```", "");
    // Liens Markdown : conserver le libellé et supprimer l'URL.
    while let Some(start) = text.find('[') {
        let Some(mid) = text[start..].find("](") else { break; };
        let mid = start + mid;
        let Some(end_rel) = text[mid + 2..].find(')') else { break; };
        let end = mid + 2 + end_rel;
        let label = text[start + 1..mid].to_string();
        text.replace_range(start..=end, &label);
    }
    text = text.lines().map(|line| {
        line.trim_start().trim_start_matches(['#', '>', '-', '*', '+']).trim_start()
    }).collect::<Vec<_>>().join(" ");
    text = text.replace("**", "").replace("__", "").replace('`', "");
    text = text.replace('*', "").replace('_', "").replace('~', "");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn speak_system_text(text: &str) -> anyhow::Result<bool> {
    speak_system_text_lang_voice(text, None, None)
}

/// Variante avec langue cible (« fr », « en »…) : la voix système par défaut suit
/// la langue de l'OS, pas celle de l'app — quand la langue est fournie, on
/// sélectionne explicitement une voix installée qui lui correspond.
pub fn speak_system_text_lang(text: &str, lang: Option<&str>) -> anyhow::Result<bool> {
    speak_system_text_lang_voice(text, lang, None)
}

/// Variante avec langue et nom de voix système explicites. Le nom vient de la
/// voix choisie dans l'interface (par ex. « Samantha » sur macOS).
pub fn speak_system_text_lang_voice(
    text: &str,
    lang: Option<&str>,
    voice: Option<&str>,
) -> anyhow::Result<bool> {
    let cleaned = strip_markdown_for_speech(text);
    let text = cleaned.trim();
    if text.is_empty() {
        return Ok(false);
    }

    // On ne tient le verrou QUE pour la déduplication (décision), jamais pendant
    // la lecture bloquante : si `say`/PowerShell traîne ou se fige, il ne doit pas
    // condamner toute synthèse vocale ultérieure du process (cause d'un « plus de
    // voix tant qu'on n'a pas redémarré Lumen »). Verrou empoisonné → on récupère.
    let lock = SYSTEM_SPEECH.get_or_init(|| Mutex::new(SystemSpeechState::default()));
    {
        let mut state = match lock.try_lock() {
            Ok(state) => state,
            Err(TryLockError::WouldBlock) => return Ok(false),
            Err(TryLockError::Poisoned(p)) => p.into_inner(),
        };
        let now = Instant::now();
        if state.last_text == text
            && state
                .last_finished
                .map(|finished| now.duration_since(finished) < Duration::from_secs(3))
                .unwrap_or(false)
        {
            return Ok(false);
        }
        // Marquage optimiste : la fenêtre anti-doublon démarre maintenant.
        state.last_text = text.to_string();
        state.last_finished = Some(now);
    } // verrou relâché AVANT la lecture bloquante

    speak(text, lang, voice)?;
    Ok(true)
}

/// macOS : retrouve une voix installée pour la langue demandée via `say -v '?'`
/// (lignes « Nom  fr_FR  # … »). Renvoie `None` si aucune ne correspond — on
/// laisse alors `say` utiliser la voix système.
#[cfg(target_os = "macos")]
fn macos_voice_for_lang(lang: &str) -> Option<String> {
    let out = std::process::Command::new("say")
        .args(["-v", "?"])
        .output()
        .ok()?;
    let listing = String::from_utf8_lossy(&out.stdout);
    let prefix = lang.to_ascii_lowercase();
    for line in listing.lines() {
        // Le nom de voix peut contenir des espaces : la locale est la première
        // colonne de la forme xx_YY ; tout ce qui précède est le nom.
        let words: Vec<&str> = line.split_whitespace().collect();
        if let Some(idx) = words.iter().position(|w| {
            w.len() >= 2 && w.chars().take(2).all(|c| c.is_ascii_lowercase()) && (w.len() == 2 || w.as_bytes().get(2) == Some(&b'_') || w.as_bytes().get(2) == Some(&b'-'))
        }) {
            if idx > 0 && words[idx].to_ascii_lowercase().starts_with(&prefix) {
                return Some(words[..idx].join(" "));
            }
        }
    }
    None
}

fn speak(text: &str, lang: Option<&str>, requested_voice: Option<&str>) -> anyhow::Result<()> {
    let lang = lang
        .map(|l| l.trim().to_ascii_lowercase())
        .filter(|l| !l.is_empty());
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("say");
        #[cfg(target_os = "macos")]
        if let Some(voice) = requested_voice.filter(|v| !v.trim().is_empty()) {
            c.args(["-v", voice]);
        } else if let Some(voice) = lang.as_deref().and_then(macos_voice_for_lang) {
            c.args(["-v", &voice]);
        }
        c.arg(text);
        c
    } else if cfg!(target_os = "windows") {
        // Sélectionne une voix de la culture demandée si disponible (sinon la
        // voix par défaut de Windows est conservée).
        let hint = match lang.as_deref() {
            Some(l) => format!(
                "try {{ $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [System.Globalization.CultureInfo]::GetCultureInfo('{}')) }} catch {{}}; ",
                l.replace('\'', "")
            ),
            None => String::new(),
        };
        let script = format!(
            "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; {hint}$s.Speak('{}')",
            text.replace('\'', "''")
        );
        let mut c = std::process::Command::new("powershell");
        c.args(["-NoProfile", "-Command", &script]);
        hide_console_window(&mut c);
        c
    } else {
        let mut c = std::process::Command::new("spd-say");
        // -w : attendre la fin de l'énoncé (sinon spd-say rend la main aussitôt).
        c.arg("-w");
        if let Some(l) = lang.as_deref() {
            c.args(["-l", l]);
        }
        c.arg(text);
        c
    };

    // On lance le process et on garde son handle pour pouvoir l'interrompre
    // (stop_system_speech). On attend ensuite par sondage, en relâchant le verrou
    // entre deux vérifications pour que l'arrêt puisse récupérer et tuer le child.
    let child = cmd
        .spawn()
        .map_err(|e| anyhow::anyhow!("Synthèse vocale indisponible : {e}"))?;
    let slot = SYSTEM_SPEECH_CHILD.get_or_init(|| Mutex::new(None));
    {
        // Un éventuel énoncé précédent est remplacé (et stoppé).
        if let Ok(mut guard) = slot.lock() {
            if let Some(mut prev) = guard.replace(child) {
                let _ = prev.kill();
                let _ = prev.wait();
            }
        }
    }
    loop {
        {
            let mut guard = match slot.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            match guard.as_mut() {
                Some(ch) => match ch.try_wait() {
                    Ok(Some(status)) => {
                        *guard = None;
                        if !status.success() {
                            anyhow::bail!("Synthèse vocale interrompue ({status})");
                        }
                        return Ok(());
                    }
                    Ok(None) => {} // toujours en cours
                    Err(e) => {
                        *guard = None;
                        return Err(anyhow::anyhow!("Synthèse vocale : {e}"));
                    }
                },
                None => return Ok(()), // interrompu via stop_system_speech
            }
        }
        std::thread::sleep(Duration::from_millis(60));
    }
}

fn hide_console_window(cmd: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

/// Percent-encoding (RFC 3986, non-réservés conservés).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Mini-évaluateur arithmétique (récursif) : + - * / % et parenthèses.
fn eval_math(expr: &str) -> Result<f64, String> {
    let tokens = tokenize(expr)?;
    let mut pos = 0;
    let v = parse_expr(&tokens, &mut pos)?;
    if pos != tokens.len() {
        return Err("jeton inattendu".into());
    }
    Ok(v)
}

#[derive(Clone, PartialEq)]
enum Tok {
    Num(f64),
    Op(char),
    LParen,
    RParen,
}

fn tokenize(s: &str) -> Result<Vec<Tok>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() || c == '.' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            let num: f64 = chars[start..i]
                .iter()
                .collect::<String>()
                .parse()
                .map_err(|_| "nombre invalide".to_string())?;
            tokens.push(Tok::Num(num));
        } else if "+-*/%".contains(c) {
            tokens.push(Tok::Op(c));
            i += 1;
        } else if c == '(' {
            tokens.push(Tok::LParen);
            i += 1;
        } else if c == ')' {
            tokens.push(Tok::RParen);
            i += 1;
        } else {
            return Err(format!("caractère invalide : {c}"));
        }
    }
    Ok(tokens)
}

fn parse_expr(t: &[Tok], pos: &mut usize) -> Result<f64, String> {
    let mut v = parse_term(t, pos)?;
    while let Some(Tok::Op(op @ ('+' | '-'))) = t.get(*pos) {
        let op = *op;
        *pos += 1;
        let rhs = parse_term(t, pos)?;
        v = if op == '+' { v + rhs } else { v - rhs };
    }
    Ok(v)
}

fn parse_term(t: &[Tok], pos: &mut usize) -> Result<f64, String> {
    let mut v = parse_factor(t, pos)?;
    while let Some(Tok::Op(op @ ('*' | '/' | '%'))) = t.get(*pos) {
        let op = *op;
        *pos += 1;
        let rhs = parse_factor(t, pos)?;
        v = match op {
            '*' => v * rhs,
            '/' => v / rhs,
            _ => v % rhs,
        };
    }
    Ok(v)
}

fn parse_factor(t: &[Tok], pos: &mut usize) -> Result<f64, String> {
    match t.get(*pos) {
        Some(Tok::Num(n)) => {
            *pos += 1;
            Ok(*n)
        }
        Some(Tok::Op('-')) => {
            *pos += 1;
            Ok(-parse_factor(t, pos)?)
        }
        Some(Tok::Op('+')) => {
            *pos += 1;
            parse_factor(t, pos)
        }
        Some(Tok::LParen) => {
            *pos += 1;
            let v = parse_expr(t, pos)?;
            if t.get(*pos) == Some(&Tok::RParen) {
                *pos += 1;
                Ok(v)
            } else {
                Err("parenthèse fermante manquante".into())
            }
        }
        _ => Err("expression incomplète".into()),
    }
}

// ===================== Blocs Raspberry Pi (feature `rpi`) =====================
//
// Approche « option B » : aucune dépendance matérielle native. Le GPIO/PWM/I²C/
// série passe par `pigs` (le client en ligne de commande de **pigpiod**, qui doit
// tourner : `sudo systemctl enable --now pigpiod`). Les infos système sont lues
// dans `/proc`, `/sys` et via `df`. Tout est du std cross-platform : hors Pi, les
// blocs échouent proprement à l'exécution (binaire/fichier absent).

#[cfg(feature = "rpi")]
fn rpi_dict(pairs: Vec<(&str, Value)>) -> Value {
    Value::Dict(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// Exécute une commande et renvoie stdout (trim). Erreur claire si absente/échec.
#[cfg(feature = "rpi")]
fn rpi_sh(cmd: &str, args: &[&str]) -> anyhow::Result<String> {
    let mut command = std::process::Command::new(cmd);
    command.args(args);
    // En AppImage, le runtime injecte PYTHONHOME/PYTHONPATH/LD_LIBRARY_PATH (vers
    // /tmp/.mount_*) dans les process enfants → casse le shim Python `pigs`
    // (pigpio-lite) : « ModuleNotFoundError: No module named 'encodings' ». On
    // purge ces variables pour que l'interpréteur système résolve normalement.
    for k in [
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "PYTHONHOME",
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "GTK_PATH",
        "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_PATH",
        "GIO_MODULE_DIR",
        "GSETTINGS_SCHEMA_DIR",
        "GDK_PIXBUF_MODULE_FILE",
        "GDK_PIXBUF_MODULEDIR",
    ] {
        command.env_remove(k);
    }
    let out = command
        .output()
        .map_err(|e| anyhow::anyhow!("« {cmd} » introuvable ({e}). Sur Pi : installe pigpio (`sudo apt install pigpio`) et lance `sudo systemctl enable --now pigpiod`."))?;
    if !out.status.success() {
        anyhow::bail!("« {cmd} » a échoué : {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(feature = "rpi")]
fn pigs(args: &[&str]) -> anyhow::Result<String> {
    rpi_sh("pigs", args)
}

/// Lit un fichier texte (trim). Pour /proc, /sys, device-tree…
#[cfg(feature = "rpi")]
fn rpi_read(path: &str) -> anyhow::Result<String> {
    Ok(std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("Lecture « {path} » impossible : {e}"))?
        .trim_matches(|c| c == '\0' || c == '\n' || c == ' ')
        .to_string())
}

/// Parse un entier décimal ou hexadécimal (`0x..`). Pour adresses/registres I²C.
#[cfg(feature = "rpi")]
fn rpi_parse_u32(s: &str) -> anyhow::Result<u32> {
    let t = s.trim();
    let v = if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u32::from_str_radix(h, 16)
    } else {
        t.parse::<u32>()
    };
    v.map_err(|_| anyhow::anyhow!("Nombre invalide : « {s} » (décimal ou 0x..)"))
}

#[cfg(feature = "rpi")]
fn register_rpi(e: &mut Engine) {
    const CAT: &str = "Raspberry Pi";

    // ---------- GPIO ----------
    reg!(
        e,
        spec("rpi_gpio_mode", "GPIO : mode", "Configure une broche GPIO en entrée ou sortie (BCM).", CAT, "settings",
            vec![
                p("pin", "Broche (BCM)", ParamKind::Number).required(),
                p("mode", "Mode", select(&["sortie", "entrée"])),
            ], false),
        |params, _ctx| {
            let pin = param_num(params, "pin") as u32;
            let m = if param_text(params, "mode") == "entrée" { "r" } else { "w" };
            pigs(&["m", &pin.to_string(), m])?;
            Ok(Value::Bool(true))
        }
    );
    reg!(
        e,
        spec("rpi_gpio_write", "GPIO : écrire", "Met une broche GPIO à l'état haut ou bas.", CAT, "zap",
            vec![
                p("pin", "Broche (BCM)", ParamKind::Number).required(),
                p("level", "Niveau", select(&["haut", "bas"])),
            ], false),
        |params, _ctx| {
            let pin = param_num(params, "pin") as u32;
            let lvl = if param_text(params, "level") == "bas" { "0" } else { "1" };
            pigs(&["w", &pin.to_string(), lvl])?;
            Ok(Value::Bool(true))
        }
    );
    reg!(
        e,
        spec("rpi_gpio_read", "GPIO : lire", "Lit l'état d'une broche GPIO (0 ou 1).", CAT, "activity",
            vec![p("pin", "Broche (BCM)", ParamKind::Number).required()], true),
        |params, _ctx| {
            let pin = param_num(params, "pin") as u32;
            let out = pigs(&["r", &pin.to_string()])?;
            Ok(Value::Number(out.trim().parse::<f64>().unwrap_or(0.0)))
        }
    );
    reg!(
        e,
        spec("rpi_gpio_pull", "GPIO : résistance interne", "Active la résistance de tirage interne d'une broche (pull-up/down).", CAT, "git-branch",
            vec![
                p("pin", "Broche (BCM)", ParamKind::Number).required(),
                p("pull", "Tirage", select(&["aucun", "haut (pull-up)", "bas (pull-down)"])),
            ], false),
        |params, _ctx| {
            let pin = param_num(params, "pin") as u32;
            let pud = match param_text(params, "pull").as_str() {
                s if s.starts_with("haut") => "u",
                s if s.starts_with("bas") => "d",
                _ => "o",
            };
            pigs(&["pud", &pin.to_string(), pud])?;
            Ok(Value::Bool(true))
        }
    );

    // ---------- PWM / Servo ----------
    reg!(
        e,
        spec("rpi_pwm", "PWM", "Applique un rapport cyclique PWM (0–255) sur une broche.", CAT, "sliders",
            vec![
                p("pin", "Broche (BCM)", ParamKind::Number).required(),
                p("duty", "Rapport cyclique (0–255)", ParamKind::Number).required(),
            ], false),
        |params, _ctx| {
            let pin = param_num(params, "pin") as u32;
            let duty = (param_num(params, "duty") as i64).clamp(0, 255);
            pigs(&["p", &pin.to_string(), &duty.to_string()])?;
            Ok(Value::Bool(true))
        }
    );
    reg!(
        e,
        spec("rpi_pwm_freq", "PWM : fréquence", "Fixe la fréquence PWM (Hz) d'une broche.", CAT, "activity",
            vec![
                p("pin", "Broche (BCM)", ParamKind::Number).required(),
                p("freq", "Fréquence (Hz)", ParamKind::Number).required(),
            ], false),
        |params, _ctx| {
            let pin = param_num(params, "pin") as u32;
            let freq = param_num(params, "freq") as u32;
            pigs(&["pfs", &pin.to_string(), &freq.to_string()])?;
            Ok(Value::Bool(true))
        }
    );
    reg!(
        e,
        spec("rpi_servo", "Servo", "Pilote un servomoteur (largeur d'impulsion 500–2500 µs, 0 = arrêt).", CAT, "rotate-ccw",
            vec![
                p("pin", "Broche (BCM)", ParamKind::Number).required(),
                p("pulse", "Impulsion (µs)", ParamKind::Number).required(),
            ], false),
        |params, _ctx| {
            let pin = param_num(params, "pin") as u32;
            let pulse = param_num(params, "pulse") as i64;
            let pulse = if pulse == 0 { 0 } else { pulse.clamp(500, 2500) };
            pigs(&["s", &pin.to_string(), &pulse.to_string()])?;
            Ok(Value::Bool(true))
        }
    );

    // ---------- I²C ----------
    reg!(
        e,
        spec("rpi_i2c_write", "I²C : écrire un octet", "Écrit un octet dans un registre d'un périphérique I²C.", CAT, "upload-cloud",
            vec![
                p("bus", "Bus", ParamKind::Number).placeholder("1"),
                p("addr", "Adresse", ParamKind::Text).required().placeholder("0x3C ou 60"),
                p("reg", "Registre", ParamKind::Text).required().placeholder("0x00"),
                p("value", "Valeur", ParamKind::Text).required().placeholder("0x01 ou 255"),
            ], false),
        |params, _ctx| {
            let bus = { let b = param_num(params, "bus") as u32; if b == 0 { 1 } else { b } };
            let addr = rpi_parse_u32(&param_text(params, "addr"))?;
            let reg = rpi_parse_u32(&param_text(params, "reg"))?;
            let val = rpi_parse_u32(&param_text(params, "value"))?;
            let handle = pigs(&["i2co", &bus.to_string(), &addr.to_string(), "0"])?;
            let h = handle.trim().to_string();
            let res = pigs(&["i2cwb", &h, &reg.to_string(), &val.to_string()]);
            let _ = pigs(&["i2cc", &h]); // ferme toujours le handle
            res?;
            Ok(Value::Bool(true))
        }
    );
    reg!(
        e,
        spec("rpi_i2c_read", "I²C : lire un octet", "Lit un octet depuis un registre d'un périphérique I²C.", CAT, "external-link",
            vec![
                p("bus", "Bus", ParamKind::Number).placeholder("1"),
                p("addr", "Adresse", ParamKind::Text).required().placeholder("0x3C ou 60"),
                p("reg", "Registre", ParamKind::Text).required().placeholder("0x00"),
            ], true),
        |params, _ctx| {
            let bus = { let b = param_num(params, "bus") as u32; if b == 0 { 1 } else { b } };
            let addr = rpi_parse_u32(&param_text(params, "addr"))?;
            let reg = rpi_parse_u32(&param_text(params, "reg"))?;
            let handle = pigs(&["i2co", &bus.to_string(), &addr.to_string(), "0"])?;
            let h = handle.trim().to_string();
            let res = pigs(&["i2crb", &h, &reg.to_string()]);
            let _ = pigs(&["i2cc", &h]);
            let out = res?;
            Ok(Value::Number(out.trim().parse::<f64>().unwrap_or(0.0)))
        }
    );

    // ---------- Série (UART) ----------
    reg!(
        e,
        spec("rpi_serial_write", "Série : écrire", "Envoie du texte sur le port série (UART).", CAT, "external-link",
            vec![
                p("device", "Périphérique", ParamKind::Text).placeholder("/dev/serial0"),
                p("baud", "Débit (bauds)", ParamKind::Number).placeholder("9600"),
                p("data", "Données", ParamKind::Multiline).placeholder("{{input}}"),
                p("newline", "Ajouter un saut de ligne", ParamKind::Bool),
            ], false),
        |params, _ctx| {
            let device = { let d = param_text(params, "device"); if d.is_empty() { "/dev/serial0".into() } else { d } };
            let baud = { let b = param_num(params, "baud") as u32; if b == 0 { 9600 } else { b } };
            let mut data = param_text(params, "data");
            if param_value(params, "newline").is_truthy() { data.push('\n'); }
            rpi_sh("stty", &["-F", &device, &baud.to_string(), "raw", "-echo"])?;
            use std::io::Write as _;
            let mut f = std::fs::OpenOptions::new().write(true).open(&device)
                .map_err(|e| anyhow::anyhow!("Ouverture « {device} » impossible : {e}"))?;
            f.write_all(data.as_bytes()).map_err(|e| anyhow::anyhow!("Écriture série impossible : {e}"))?;
            Ok(Value::Bool(true))
        }
    );
    reg!(
        e,
        spec("rpi_serial_read", "Série : lire", "Lit le texte disponible sur le port série (avec délai d'attente).", CAT, "message-square",
            vec![
                p("device", "Périphérique", ParamKind::Text).placeholder("/dev/serial0"),
                p("baud", "Débit (bauds)", ParamKind::Number).placeholder("9600"),
                p("timeout", "Délai (dixièmes de s)", ParamKind::Number).placeholder("10 = 1 s"),
            ], true),
        |params, _ctx| {
            let device = { let d = param_text(params, "device"); if d.is_empty() { "/dev/serial0".into() } else { d } };
            let baud = { let b = param_num(params, "baud") as u32; if b == 0 { 9600 } else { b } };
            let time = { let t = param_num(params, "timeout") as u32; if t == 0 { 10 } else { t } };
            // min 0 + time N : read() rend la main après N dixièmes de seconde même sans donnée.
            rpi_sh("stty", &["-F", &device, &baud.to_string(), "raw", "-echo", "min", "0", "time", &time.to_string()])?;
            use std::io::Read as _;
            let mut f = std::fs::File::open(&device)
                .map_err(|e| anyhow::anyhow!("Ouverture « {device} » impossible : {e}"))?;
            let mut buf = [0u8; 4096];
            let n = f.read(&mut buf).map_err(|e| anyhow::anyhow!("Lecture série impossible : {e}"))?;
            Ok(Value::Text(String::from_utf8_lossy(&buf[..n]).to_string()))
        }
    );

    // ---------- Infos système ----------
    reg!(
        e,
        spec("rpi_cpu_temp", "Pi : température CPU", "Température du SoC en °C.", CAT, "activity",
            vec![], true),
        |_params, _ctx| {
            let raw = rpi_read("/sys/class/thermal/thermal_zone0/temp")?;
            let milli: f64 = raw.trim().parse().unwrap_or(0.0);
            Ok(Value::Number((milli / 1000.0 * 10.0).round() / 10.0))
        }
    );
    reg!(
        e,
        spec("rpi_mem", "Pi : mémoire", "Mémoire totale/utilisée/libre (Mo) et pourcentage.", CAT, "sliders",
            vec![], true),
        |_params, _ctx| {
            let s = rpi_read("/proc/meminfo")?;
            let kb = |key: &str| -> f64 {
                s.lines().find(|l| l.starts_with(key))
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0)
            };
            let total = kb("MemTotal:");
            let avail = kb("MemAvailable:");
            let used = (total - avail).max(0.0);
            let pct = if total > 0.0 { (used / total * 1000.0).round() / 10.0 } else { 0.0 };
            Ok(rpi_dict(vec![
                ("total_mb", Value::Number((total / 1024.0).round())),
                ("used_mb", Value::Number((used / 1024.0).round())),
                ("free_mb", Value::Number((avail / 1024.0).round())),
                ("percent", Value::Number(pct)),
            ]))
        }
    );
    reg!(
        e,
        spec("rpi_disk", "Pi : espace disque", "Espace total/utilisé/libre (Mo) et pourcentage d'un point de montage.", CAT, "file-text",
            vec![p("path", "Chemin", ParamKind::Text).placeholder("/")], true),
        |params, _ctx| {
            let path = { let p = param_text(params, "path"); if p.is_empty() { "/".into() } else { p } };
            let out = rpi_sh("df", &["-kP", &path])?;
            let line = out.lines().nth(1).ok_or_else(|| anyhow::anyhow!("df : sortie inattendue"))?;
            let f: Vec<&str> = line.split_whitespace().collect();
            let kb = |i: usize| -> f64 { f.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) };
            let total = kb(1); let used = kb(2); let avail = kb(3);
            let pct = if total > 0.0 { (used / total * 1000.0).round() / 10.0 } else { 0.0 };
            Ok(rpi_dict(vec![
                ("total_mb", Value::Number((total / 1024.0).round())),
                ("used_mb", Value::Number((used / 1024.0).round())),
                ("free_mb", Value::Number((avail / 1024.0).round())),
                ("percent", Value::Number(pct)),
            ]))
        }
    );
    reg!(
        e,
        spec("rpi_load", "Pi : charge CPU", "Charge moyenne du système (1/5/15 min).", CAT, "activity",
            vec![], true),
        |_params, _ctx| {
            let s = rpi_read("/proc/loadavg")?;
            let f: Vec<&str> = s.split_whitespace().collect();
            let n = |i: usize| -> f64 { f.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) };
            Ok(rpi_dict(vec![
                ("load1", Value::Number(n(0))),
                ("load5", Value::Number(n(1))),
                ("load15", Value::Number(n(2))),
            ]))
        }
    );
    reg!(
        e,
        spec("rpi_uptime", "Pi : temps de fonctionnement", "Durée depuis le démarrage, en secondes.", CAT, "rotate-ccw",
            vec![], true),
        |_params, _ctx| {
            let s = rpi_read("/proc/uptime")?;
            let secs = s.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
            Ok(Value::Number(secs.round()))
        }
    );
    reg!(
        e,
        spec("rpi_info", "Pi : informations", "Résumé du Pi : modèle, hôte, température, mémoire, disque, charge, uptime (Dict).", CAT, "settings",
            vec![], true),
        |_params, _ctx| {
            let model = rpi_read("/proc/device-tree/model").unwrap_or_else(|_| "inconnu".into());
            let host = rpi_read("/proc/sys/kernel/hostname").unwrap_or_default();
            let temp = rpi_read("/sys/class/thermal/thermal_zone0/temp").ok()
                .and_then(|r| r.trim().parse::<f64>().ok()).map(|m| (m / 1000.0 * 10.0).round() / 10.0).unwrap_or(0.0);
            // Mémoire
            let mem = rpi_read("/proc/meminfo").unwrap_or_default();
            let kb = |key: &str| -> f64 {
                mem.lines().find(|l| l.starts_with(key))
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0)
            };
            let mtotal = kb("MemTotal:"); let mavail = kb("MemAvailable:");
            let mem_pct = if mtotal > 0.0 { ((mtotal - mavail) / mtotal * 1000.0).round() / 10.0 } else { 0.0 };
            // Disque /
            let disk_pct = rpi_sh("df", &["-kP", "/"]).ok()
                .and_then(|o| o.lines().nth(1).map(|l| l.to_string()))
                .and_then(|l| {
                    let f: Vec<&str> = l.split_whitespace().collect();
                    let t = f.get(1).and_then(|v| v.parse::<f64>().ok())?;
                    let u = f.get(2).and_then(|v| v.parse::<f64>().ok())?;
                    if t > 0.0 { Some((u / t * 1000.0).round() / 10.0) } else { Some(0.0) }
                }).unwrap_or(0.0);
            let load1 = rpi_read("/proc/loadavg").ok()
                .and_then(|s| s.split_whitespace().next().and_then(|v| v.parse::<f64>().ok())).unwrap_or(0.0);
            let uptime = rpi_read("/proc/uptime").ok()
                .and_then(|s| s.split_whitespace().next().and_then(|v| v.parse::<f64>().ok())).map(|f| f.round()).unwrap_or(0.0);
            Ok(rpi_dict(vec![
                ("model", Value::Text(model)),
                ("hostname", Value::Text(host)),
                ("cpu_temp_c", Value::Number(temp)),
                ("mem_percent", Value::Number(mem_pct)),
                ("mem_total_mb", Value::Number((mtotal / 1024.0).round())),
                ("disk_percent", Value::Number(disk_pct)),
                ("load1", Value::Number(load1)),
                ("uptime_s", Value::Number(uptime)),
            ]))
        }
    );

    // ---------- SPI ----------
    reg!(
        e,
        spec("rpi_spi_transfer", "SPI : transfert", "Échange des octets sur le bus SPI (écrit et lit simultanément). Renvoie les octets lus (hex).", CAT, "git-branch",
            vec![
                p("channel", "Canal (CE0=0, CE1=1)", ParamKind::Number).placeholder("0"),
                p("baud", "Débit (Hz)", ParamKind::Number).placeholder("500000"),
                p("data", "Octets à envoyer", ParamKind::Text).required().placeholder("0x01 0xFF 0x00 ou 1,255,0"),
            ], true),
        |params, _ctx| {
            let chan = param_num(params, "channel") as u32;
            let baud = { let b = param_num(params, "baud") as u32; if b == 0 { 500000 } else { b } };
            let bytes = rpi_parse_bytes(&param_text(params, "data"))?;
            if bytes.is_empty() { anyhow::bail!("Aucun octet à envoyer"); }
            let handle = pigs(&["spio", &chan.to_string(), &baud.to_string(), "0"])?;
            let h = handle.trim().to_string();
            // pigs spix <handle> <octets…> : transfert duplex, renvoie « count o0 o1 … ».
            let mut args: Vec<String> = vec!["spix".into(), h.clone()];
            for b in &bytes { args.push(b.to_string()); }
            let argr: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            let res = pigs(&argr);
            let _ = pigs(&["spic", &h]); // ferme toujours le handle
            let out = res?;
            // Premier nombre = compte d'octets lus ; le reste = les octets.
            let read: Vec<String> = out.split_whitespace().skip(1)
                .map(|n| n.parse::<u32>().map(|v| format!("0x{:02X}", v)).unwrap_or_else(|_| n.to_string()))
                .collect();
            Ok(Value::Text(read.join(" ")))
        }
    );

    // ---------- 1-Wire (DS18B20 & co. via sysfs) ----------
    reg!(
        e,
        spec("rpi_w1_list", "1-Wire : périphériques", "Liste les identifiants des périphériques 1-Wire détectés.", CAT, "file-text",
            vec![], true),
        |_params, _ctx| {
            let mut ids: Vec<Value> = Vec::new();
            if let Ok(entries) = std::fs::read_dir("/sys/bus/w1/devices") {
                for ent in entries.flatten() {
                    let name = ent.file_name().to_string_lossy().to_string();
                    if name.starts_with("w1_bus_master") { continue; }
                    ids.push(Value::Text(name));
                }
            }
            ids.sort_by(|a, b| a.as_text().cmp(&b.as_text()));
            Ok(Value::List(ids))
        }
    );
    reg!(
        e,
        spec("rpi_w1_temp", "1-Wire : température (DS18B20)", "Lit la température (°C) d'un capteur DS18B20. Identifiant vide = premier capteur trouvé.", CAT, "activity",
            vec![p("id", "Identifiant", ParamKind::Text).placeholder("28-xxxxxxxxxxxx (vide = auto)")], true),
        |params, _ctx| {
            // Identifiant explicite, ou premier périphérique « 28-* » (famille DS18B20).
            let id = {
                let given = param_text(params, "id");
                if !given.is_empty() { given } else {
                    std::fs::read_dir("/sys/bus/w1/devices").ok()
                        .and_then(|entries| entries.flatten()
                            .map(|e| e.file_name().to_string_lossy().to_string())
                            .find(|n| n.starts_with("28-")))
                        .ok_or_else(|| anyhow::anyhow!("Aucun capteur DS18B20 (28-*) trouvé. Active 1-Wire : dtoverlay=w1-gpio dans /boot/config.txt."))?
                }
            };
            let base = format!("/sys/bus/w1/devices/{id}");
            // Noyaux récents : fichier « temperature » (milli-°C). Sinon « w1_slave » (t=…).
            if let Ok(s) = rpi_read(&format!("{base}/temperature")) {
                if let Ok(milli) = s.trim().parse::<f64>() {
                    return Ok(Value::Number((milli / 1000.0 * 100.0).round() / 100.0));
                }
            }
            let slave = rpi_read(&format!("{base}/w1_slave"))?;
            if !slave.contains("YES") {
                anyhow::bail!("Lecture CRC invalide du capteur {id}");
            }
            let milli = slave.rsplit("t=").next().and_then(|t| t.trim().parse::<f64>().ok())
                .ok_or_else(|| anyhow::anyhow!("Température illisible pour {id}"))?;
            Ok(Value::Number((milli / 1000.0 * 100.0).round() / 100.0))
        }
    );

    // ---------- Synthèse vocale (Piper, via le pont Lumen) ----------
    reg!(
        e,
        spec("rpi_tts", "Synthèse vocale (Piper)", "Énonce un texte avec Piper sur le Pi (voix active de Lumen, ou voix précisée).", CAT, "volume-2",
            vec![
                p("text", "Texte", ParamKind::Multiline).required().placeholder("{{input}}"),
                p("voice", "Voix (option)", ParamKind::Text).placeholder("Laisser vide = voix active des réglages (ex. fr_FR-siwis-medium)"),
            ], false),
        |params, _ctx| {
            let text = param_text(params, "text");
            if text.trim().is_empty() { anyhow::bail!("Texte vide"); }
            crate::lumen::post_json("/tts", serde_json::json!({
                "text": text,
                "voice": param_text(params, "voice"),
            }))?;
            Ok(Value::Bool(true))
        }
    );
}

/// Parse une liste d'octets « 0x01 0xFF 12, 255 » (espaces/virgules, hex ou déc).
#[cfg(feature = "rpi")]
fn rpi_parse_bytes(s: &str) -> anyhow::Result<Vec<u32>> {
    s.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|t| !t.is_empty())
        .map(|t| rpi_parse_u32(t).map(|v| v & 0xFF))
        .collect()
}

#[cfg(test)]
mod sql_tests {
    use super::*;

    #[test]
    fn sqlite_roundtrip_and_select() {
        let dir = std::env::temp_dir().join(format!("fluxo_sql_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        // CREATE + INSERT paramétré → rows_affected ; SELECT paramétré → lignes.
        let _ = run_sqlite(&dir, "CREATE TABLE t(id INTEGER, name TEXT)", &[], 1000).unwrap();
        let ins = run_sqlite(
            &dir,
            "INSERT INTO t(id, name) VALUES(?, ?)",
            &[serde_json::json!(1), serde_json::json!("Léa")],
            1000,
        )
        .unwrap();
        match ins {
            Value::Dict(d) => assert_eq!(d.get("rows_affected"), Some(&Value::Number(1.0))),
            _ => panic!("attendu rows_affected"),
        }
        let sel = run_sqlite(&dir, "SELECT name FROM t WHERE id = ?", &[serde_json::json!(1)], 1000).unwrap();
        match sel {
            Value::List(rows) => {
                assert_eq!(rows.len(), 1);
                match &rows[0] {
                    Value::Dict(o) => assert_eq!(o.get("name"), Some(&Value::Text("Léa".into()))),
                    _ => panic!("ligne attendue"),
                }
            }
            _ => panic!("attendu une liste"),
        }
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn injection_is_bound_not_concatenated() {
        let dir = std::env::temp_dir().join(format!("fluxo_inj_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        run_sqlite(&dir, "CREATE TABLE t(name TEXT)", &[], 1000).unwrap();
        run_sqlite(&dir, "INSERT INTO t(name) VALUES(?)", &[serde_json::json!("ok")], 1000).unwrap();
        // Tentative d'injection : la valeur est liée, donc traitée comme une donnée.
        let evil = "x'; DROP TABLE t; --";
        run_sqlite(&dir, "INSERT INTO t(name) VALUES(?)", &[serde_json::json!(evil)], 1000).unwrap();
        // La table existe toujours et contient bien 2 lignes.
        let sel = run_sqlite(&dir, "SELECT name FROM t", &[], 1000).unwrap();
        match sel {
            Value::List(rows) => assert_eq!(rows.len(), 2),
            _ => panic!("table détruite : l'injection a réussi !"),
        }
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn notification_actions_parsing() {
        let a = parse_notification_actions("*ouvrir | Ouvrir\nplus_tard | Plus tard\nJuste un label");
        assert_eq!(a.len(), 3);
        assert_eq!(a[0]["id"], "ouvrir");
        assert_eq!(a[0]["label"], "Ouvrir");
        assert_eq!(a[0]["primary"], true);
        assert_eq!(a[1]["primary"], false);
        assert_eq!(a[2]["id"], "juste_un_label");
        assert!(parse_notification_actions("   \n  ").is_empty());
    }

    #[test]
    fn http_headers_parse_line_format() {
        let headers = parse_http_headers("Authorization: Bearer token\nAccept: application/json").unwrap();
        assert_eq!(headers.get("authorization").unwrap(), "Bearer token");
        assert_eq!(headers.get("accept").unwrap(), "application/json");
    }

    #[test]
    fn http_headers_parse_json_format() {
        let headers = parse_http_headers(r#"{"Authorization":"Bearer token","X-Retry":3,"X-Debug":true}"#).unwrap();
        assert_eq!(headers.get("authorization").unwrap(), "Bearer token");
        assert_eq!(headers.get("x-retry").unwrap(), "3");
        assert_eq!(headers.get("x-debug").unwrap(), "true");
    }

    #[test]
    fn http_headers_reject_invalid_lines() {
        let err = parse_http_headers("Authorization Bearer token").unwrap_err().to_string();
        assert!(err.contains("Nom: valeur"), "{err}");
    }

    #[test]
    fn read_detection() {
        assert!(sql_is_read("  select * from t"));
        assert!(sql_is_read("WITH x AS (…) SELECT …"));
        assert!(!sql_is_read("INSERT INTO t VALUES(1)"));
        assert!(!sql_is_read("update t set a=1"));
    }
}
