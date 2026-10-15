//! Blocs Fluxo des applications de Lumen (propres à la copie vendorisée).
//!
//! Deux ponts, tous deux servis par le serveur loopback de Lumen :
//!   - `POST /fluxo/native` {name, args} : un outil natif (native_tools.rs) —
//!     agenda, tâches, coffre, courrier, données en direct, web, fichiers,
//!     domotique. Le même code que les agents : pas de seconde implémentation.
//!   - `POST /fluxo/intent` {app, intent, args} : une App Intent déclarée au
//!     manifeste d'un paquet (Notes, Études, Carte, Python, Analyse de données,
//!     Tâches planifiées, Domotique…), exécutée par le bureau ou la coque du
//!     mode application.
//!
//! Les blocs sont décrits par des tables : ajouter un outil = une ligne.

use super::{p, select, spec, FnAction};
use crate::action::{param_text, ParamKind, ParamSpec};
use crate::engine::Engine;
use crate::value::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Paramètre d'un bloc : (clé, libellé, type, requis, indice).
type P = (&'static str, &'static str, Kind, bool, &'static str);

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Multi,
    Num,
    Bool,
    Sel(&'static [&'static str]),
}

fn param(def: &P) -> ParamSpec {
    let (key, label, kind, required, hint) = *def;
    let k = match kind {
        Kind::Text => ParamKind::Text,
        Kind::Multi => ParamKind::Multiline,
        Kind::Num => ParamKind::Number,
        Kind::Bool => ParamKind::Bool,
        Kind::Sel(opts) => select(opts),
    };
    let mut ps = p(key, label, k);
    if required {
        ps = ps.required();
    }
    if !hint.is_empty() {
        ps = ps.placeholder(hint);
    }
    ps
}

/// Valeurs des paramètres → arguments JSON (vides omis, types conservés).
fn args_of(defs: &[P], params: &BTreeMap<String, Value>) -> anyhow::Result<serde_json::Value> {
    let mut out = serde_json::Map::new();
    for (key, label, kind, required, _) in defs {
        let v = params.get(*key);
        let j = match (kind, v) {
            (Kind::Num, Some(v)) => v.as_number().map(|n| serde_json::json!(n)),
            (Kind::Bool, Some(Value::Bool(b))) => Some(serde_json::json!(b)),
            (Kind::Bool, Some(v)) => {
                let t = v.as_text().to_lowercase();
                if t.is_empty() { None } else { Some(serde_json::json!(matches!(t.as_str(), "true" | "1" | "oui" | "yes"))) }
            }
            (_, Some(v)) => {
                let t = v.as_text();
                if t.trim().is_empty() { None } else { Some(serde_json::Value::String(t)) }
            }
            _ => None,
        };
        match j {
            Some(j) => { out.insert((*key).to_string(), j); }
            None if *required => anyhow::bail!("Paramètre requis : {label}"),
            None => {}
        }
    }
    Ok(serde_json::Value::Object(out))
}

/// Une réponse JSON de Lumen devient une valeur structurée (listes, objets) ;
/// sinon un texte.
fn as_value(text: String) -> Value {
    let t = text.trim();
    if t.starts_with('{') || t.starts_with('[') {
        if let Ok(j) = serde_json::from_str::<serde_json::Value>(t) {
            return crate::value::json_to_value(&j);
        }
    }
    Value::Text(text)
}

struct Native {
    id: &'static str,
    name: &'static str,
    desc: &'static str,
    cat: &'static str,
    icon: &'static str,
    tool: &'static str,
    params: &'static [P],
}

struct Intent {
    id: &'static str,
    name: &'static str,
    desc: &'static str,
    cat: &'static str,
    icon: &'static str,
    app: &'static str,
    intent: &'static str,
    params: &'static [P],
}

const PERIODS: &[&str] = &["", "today", "tomorrow", "week", "next_7_days", "weekend", "month", "yesterday", "last_week"];

const NATIVE: &[Native] = &[
    // ---- Organisation ----
    Native { id: "app_agenda", name: "Agenda : planning", desc: "Évènements, rappels, échéances et anniversaires de toutes les sources (Agenda, iPhone, Kanban, agents) pour une période.", cat: "Apps", icon: "calendar", tool: "data_agenda",
        params: &[("period", "Période", Kind::Sel(PERIODS), false, ""), ("query", "Mot-clé", Kind::Text, false, "dentiste, anniversaire…")] },
    Native { id: "app_tasks", name: "Tâches : lister", desc: "Toutes les tâches, toutes apps confondues (Kanban, rappels, agents).", cat: "Apps", icon: "list-checks", tool: "data_tasks",
        params: &[("status", "Statut", Kind::Sel(&["open", "done", "all"]), false, ""), ("query", "Mot-clé", Kind::Text, false, "")] },
    Native { id: "app_reminder", name: "Rappel : créer", desc: "Crée un rappel daté (notification à l'heure dite).", cat: "Apps", icon: "bell", tool: "create_reminder",
        params: &[("title", "Texte", Kind::Text, true, "Appeler le plombier"), ("due_at_iso", "Échéance (ISO)", Kind::Text, true, "2026-10-12T18:00:00"), ("note", "Note", Kind::Text, false, "")] },
    Native { id: "app_data_search", name: "Mes données : rechercher", desc: "Recherche plein texte dans toutes les données de l'utilisateur (notes, documents, tâches, contacts, courriels, tables, santé…).", cat: "Apps", icon: "search", tool: "data_search",
        params: &[("query", "Recherche", Kind::Text, true, "{{input}}"), ("app", "App", Kind::Text, false, "notes, courrier, kanban…"), ("period", "Période", Kind::Sel(PERIODS), false, "")] },
    Native { id: "app_data_get", name: "Mes données : lire une fiche", desc: "Lit une fiche complète par son identifiant (donné par une recherche).", cat: "Apps", icon: "file-text", tool: "data_get",
        params: &[("id", "Identifiant", Kind::Text, true, "{{last}}")] },
    Native { id: "app_metrics", name: "Santé & mesures", desc: "Mesures chiffrées et leur évolution (pas, sommeil, fréquence cardiaque, compteurs du coffre).", cat: "Apps", icon: "activity", tool: "data_metrics",
        params: &[("query", "Mesure", Kind::Text, false, "sommeil, pas…")] },
    // ---- Coffre (synchronisé avec le téléphone) ----
    Native { id: "app_vault_get", name: "Coffre : lire", desc: "Lit une valeur du coffre clé → valeur (partagé avec le téléphone et les Raccourcis).", cat: "Apps", icon: "lock", tool: "vault_get",
        params: &[("key", "Clé", Kind::Text, true, "courses")] },
    Native { id: "app_vault_set", name: "Coffre : écrire", desc: "Écrit une valeur dans le coffre.", cat: "Apps", icon: "lock", tool: "vault_set",
        params: &[("key", "Clé", Kind::Text, true, "maison/chauffage"), ("value", "Valeur", Kind::Text, true, "{{last}}"), ("type", "Type", Kind::Sel(&["", "text", "number", "bool", "date", "list"]), false, "")] },
    Native { id: "app_vault_append", name: "Coffre : ajouter à une liste", desc: "Ajoute un élément à une liste du coffre (ex. liste de courses).", cat: "Apps", icon: "list", tool: "vault_append",
        params: &[("key", "Liste", Kind::Text, true, "courses"), ("item", "Élément", Kind::Text, true, "lait")] },
    // ---- Courrier ----
    Native { id: "app_mail_list", name: "Email : derniers messages", desc: "Liste les derniers e-mails relevés par l'app Email (ou seulement les non lus).", cat: "Apps", icon: "mail", tool: "mail_list_messages",
        params: &[("limit", "Nombre", Kind::Num, false, "10"), ("unread_only", "Non lus seulement", Kind::Bool, false, "")] },
    Native { id: "app_mail_read", name: "Email : lire un message", desc: "Lit un e-mail en entier par son uid ou son sujet.", cat: "Apps", icon: "mail", tool: "mail_read_message",
        params: &[("uid", "UID", Kind::Text, false, ""), ("subject", "Sujet", Kind::Text, false, "")] },
    Native { id: "app_mail_draft", name: "Email : préparer un brouillon", desc: "Rédige un e-mail rangé dans les brouillons (jamais envoyé automatiquement).", cat: "Apps", icon: "send", tool: "mail_write_draft",
        params: &[("to", "Destinataire", Kind::Text, false, "nom@exemple.fr"), ("subject", "Sujet", Kind::Text, false, ""), ("body", "Message", Kind::Multi, true, "{{last}}")] },
    // ---- Données en direct ----
    Native { id: "app_weather", name: "Météo", desc: "Météo actuelle et prévisions pour un lieu (Open-Meteo).", cat: "Apps", icon: "cloud-sun", tool: "weather_now",
        params: &[("place", "Lieu", Kind::Text, false, "Lyon (vide = lieu habituel)")] },
    Native { id: "app_air_quality", name: "Qualité de l'air (extérieur)", desc: "Indice de qualité de l'air et polluants pour un lieu.", cat: "Apps", icon: "wind", tool: "air_quality",
        params: &[("place", "Lieu", Kind::Text, true, "Paris")] },
    Native { id: "app_news", name: "Actualités", desc: "Titres récents sur un sujet.", cat: "Apps", icon: "newspaper", tool: "news_headlines",
        params: &[("topic", "Sujet", Kind::Text, false, "à la une"), ("count", "Nombre", Kind::Num, false, "5")] },
    Native { id: "app_market", name: "Cours de bourse / crypto", desc: "Cours d'une action, d'un indice ou d'une cryptomonnaie.", cat: "Apps", icon: "chart-line", tool: "market_quote",
        params: &[("query", "Valeur", Kind::Text, true, "AAPL, CAC 40, bitcoin…")] },
    Native { id: "app_exchange", name: "Taux de change", desc: "Conversion entre deux devises au taux du jour.", cat: "Apps", icon: "repeat", tool: "exchange_rate",
        params: &[("from", "De", Kind::Text, true, "EUR"), ("to", "Vers", Kind::Text, true, "USD"), ("amount", "Montant", Kind::Num, false, "1")] },
    Native { id: "app_sport", name: "Score sportif", desc: "Score en direct ou résultat d'un match.", cat: "Apps", icon: "trophy", tool: "sport_score",
        params: &[("team", "Équipe", Kind::Text, false, "PSG"), ("league", "Compétition", Kind::Text, false, "Ligue 1")] },
    // ---- Web & fichiers ----
    Native { id: "app_web_search", name: "Recherche web", desc: "Recherche sur le web (seul bloc qui sort de la machine ; doit être activé dans les Réglages).", cat: "Apps", icon: "globe", tool: "web_search",
        params: &[("query", "Recherche", Kind::Text, true, "{{input}}")] },
    Native { id: "app_web_read", name: "Lire une page web", desc: "Récupère le texte lisible d'une adresse web.", cat: "Apps", icon: "file-text", tool: "web_read_page",
        params: &[("url", "Adresse", Kind::Text, true, "https://…")] },
    Native { id: "app_docs_search", name: "Base de connaissances : chercher", desc: "Passages pertinents des documents indexés (Corpus / RAG).", cat: "Apps", icon: "library", tool: "search_documents",
        params: &[("query", "Question", Kind::Text, true, "{{input}}")] },
    Native { id: "app_morning", name: "Matin : régler la vue", desc: "Configure l'écran du matin (sections, ville météo…).", cat: "Apps", icon: "sun", tool: "morning_configure",
        params: &[("city", "Ville météo", Kind::Text, false, "")] },
    Native { id: "app_messenger", name: "Messagerie d'agents : écrire", desc: "Dépose un message dans la messagerie des agents (boîte de réception).", cat: "Apps", icon: "message-circle", tool: "send_inbox_message",
        params: &[("subject", "Sujet", Kind::Text, false, "Rapport"), ("body", "Message", Kind::Multi, true, "{{last}}")] },
    // ---- Domotique (lecture fine) ----
    Native { id: "domotique_summary", name: "Domotique : inventaire", desc: "Liste les objets et leurs composants (clés utilisables par les autres blocs).", cat: "Domotique", icon: "house", tool: "domotique_list_devices",
        params: &[] },
];

const INTENTS: &[Intent] = &[
    // ---- Notes ----
    Intent { id: "app_note_create", name: "Notes : créer une note", desc: "Crée une note (Markdown accepté) dans le carnet.", cat: "Apps", icon: "notebook-pen", app: "notes", intent: "create_note",
        params: &[("title", "Titre", Kind::Text, true, "Compte rendu du {{date}}"), ("body", "Contenu", Kind::Multi, true, "{{last}}")] },
    Intent { id: "app_note_append", name: "Notes : compléter une note", desc: "Ajoute du texte à la fin d'une note existante.", cat: "Apps", icon: "notebook-pen", app: "notes", intent: "append_note",
        params: &[("note", "Note", Kind::Text, true, "Journal"), ("text", "Texte", Kind::Multi, true, "{{last}}")] },
    Intent { id: "app_note_read", name: "Notes : lire une note", desc: "Renvoie le contenu complet d'une note.", cat: "Apps", icon: "notebook-pen", app: "notes", intent: "read_note",
        params: &[("note", "Note", Kind::Text, true, "Journal")] },
    Intent { id: "app_note_list", name: "Notes : lister", desc: "Liste les notes du carnet (filtre texte facultatif).", cat: "Apps", icon: "notebook-pen", app: "notes", intent: "list_notes",
        params: &[("query", "Filtre", Kind::Text, false, "")] },
    // ---- Études ----
    Intent { id: "app_studies_add", name: "Études : ajouter un cours", desc: "Ajoute un texte de cours à une matière (créée si besoin) pour en tirer fiches et quiz.", cat: "Apps", icon: "book-open", app: "studies", intent: "studies_add_course",
        params: &[("course", "Matière", Kind::Text, true, "Histoire"), ("title", "Titre", Kind::Text, true, "Chapitre 3"), ("text", "Texte du cours", Kind::Multi, true, "{{last}}")] },
    Intent { id: "app_studies_due", name: "Études : fiches à réviser", desc: "Nombre de fiches à revoir aujourd'hui, par matière.", cat: "Apps", icon: "book-open", app: "studies", intent: "studies_due", params: &[] },
    Intent { id: "app_studies_exams", name: "Études : examens à venir", desc: "Liste des examens à venir.", cat: "Apps", icon: "book-open", app: "studies", intent: "studies_exams", params: &[] },
    // ---- Données & calcul ----
    Intent { id: "app_python", name: "Python : exécuter", desc: "Exécute un script Python isolé (numpy, pandas, matplotlib ; fichiers de la sandbox accessibles) et renvoie la sortie.", cat: "Apps", icon: "terminal", app: "python", intent: "run_python",
        params: &[("code", "Code", Kind::Multi, true, "print(2 ** 10)"), ("stdin", "Entrée standard", Kind::Multi, false, "")] },
    Intent { id: "app_analyze", name: "Analyse de données : question", desc: "Répond à une question chiffrée sur le rapport ouvert dans Analyse de données.", cat: "Apps", icon: "chart-column", app: "dataanalysis", intent: "analyze_data",
        params: &[("question", "Question", Kind::Text, true, "Ventes du mois par région ?")] },
    Intent { id: "app_report_send", name: "Analyse de données : envoyer le rapport", desc: "Exporte le rapport ouvert (PDF ou HTML) et l'envoie par e-mail.", cat: "Apps", icon: "send", app: "dataanalysis", intent: "send_report",
        params: &[("to", "Destinataires", Kind::Text, true, "equipe@exemple.fr"), ("subject", "Sujet", Kind::Text, false, ""), ("format", "Format", Kind::Sel(&["pdf", "html"]), false, "")] },
    // ---- Carte, médias, planification ----
    Intent { id: "app_map", name: "Carte : afficher", desc: "Demande en langage naturel à l'app Carte : lieu, objets OpenStreetMap, jeux de données data.gouv.", cat: "Apps", icon: "map-pin", app: "carte", intent: "carte_show",
        params: &[("request", "Demande", Kind::Text, true, "pharmacies autour de Saint-Pierre")] },
    Intent { id: "app_media_montage", name: "Médias : créer un montage", desc: "Monte automatiquement une vidéo à partir des médias des sandboxes (consigne en langage naturel).", cat: "Apps", icon: "film", app: "media", intent: "media_create_montage",
        params: &[("instruction", "Consigne", Kind::Multi, true, "Reel 9:16 de 30 s avec mes photos de vacances")] },
    Intent { id: "app_task_run", name: "Tâches planifiées : lancer", desc: "Exécute immédiatement une tâche planifiée par son titre.", cat: "Apps", icon: "clock", app: "scheduler", intent: "run_scheduled_task",
        params: &[("task", "Tâche", Kind::Text, true, "Résumé du matin")] },
    Intent { id: "app_task_list", name: "Tâches planifiées : lister", desc: "Liste les tâches planifiées et leur prochaine exécution.", cat: "Apps", icon: "clock", app: "scheduler", intent: "list_scheduled_tasks", params: &[] },
    // ---- Domotique ----
    Intent { id: "domotique_scene", name: "Domotique : lancer une scène", desc: "Lance une scène enregistrée dans l'app Domotique (plusieurs commandes d'un coup).", cat: "Domotique", icon: "sparkles", app: "domotique", intent: "run_scene",
        params: &[("scene", "Scène", Kind::Text, true, "Soirée")] },
];

/// Lecture d'une mesure de domotique : `/domotique/state` → nombre.
fn domotique_field(device: &str, component: &str, field: &str) -> anyhow::Result<f64> {
    let raw = crate::lumen::post_json("/domotique/state", serde_json::json!({ "device": device }))?;
    let j: serde_json::Value = serde_json::from_str(raw.trim())
        .map_err(|_| anyhow::anyhow!("État illisible : {raw}"))?;
    // /state est soit plat (objet mono), soit un sous-objet par composant.
    let mut node = j.get("state").cloned().unwrap_or(j);
    if !component.trim().is_empty() {
        node = node.get(component.trim()).cloned().unwrap_or(serde_json::Value::Null);
    } else if node.get(field).is_none() {
        if let Some(obj) = node.as_object() {
            if let Some(sub) = obj.values().find(|v| v.get(field).is_some()) {
                node = sub.clone();
            }
        }
    }
    match node.get(field) {
        Some(serde_json::Value::Number(n)) => Ok(n.as_f64().unwrap_or(0.0)),
        Some(serde_json::Value::Bool(b)) => Ok(if *b { 1.0 } else { 0.0 }),
        Some(serde_json::Value::String(s)) => s.parse::<f64>().map_err(|_| anyhow::anyhow!("« {field} » n'est pas numérique ({s})")),
        _ => anyhow::bail!("Mesure « {field} » introuvable sur « {device} »"),
    }
}

const FIELDS: &[&str] = &["temp", "hum", "co2", "pm25", "pm10", "pm1", "level", "motion", "open", "leak", "ring", "setpoint", "heating", "on", "brightness", "angle"];

pub fn register_lumen_apps(e: &mut Engine) {
    for b in NATIVE {
        let defs = b.params;
        let tool = b.tool;
        e.register(Arc::new(FnAction {
            spec: spec(b.id, b.name, b.desc, b.cat, b.icon, defs.iter().map(param).collect(), true),
            run: Box::new(move |params, _ctx| {
                let args = args_of(defs, params)?;
                let out = crate::lumen::post_json_timeout("/fluxo/native", serde_json::json!({ "name": tool, "args": args }), 90)?;
                Ok(as_value(out))
            }),
        }));
    }
    for b in INTENTS {
        let defs = b.params;
        let (app, intent) = (b.app, b.intent);
        e.register(Arc::new(FnAction {
            spec: spec(b.id, b.name, b.desc, b.cat, b.icon, defs.iter().map(param).collect(), true),
            run: Box::new(move |params, _ctx| {
                let args = args_of(defs, params)?;
                let out = crate::lumen::post_json_timeout("/fluxo/intent", serde_json::json!({ "app": app, "intent": intent, "args": args }), 130)?;
                Ok(as_value(out))
            }),
        }));
    }

    // ---- Action d'app générique : toute App Intent d'un paquet installé ----
    e.register(Arc::new(FnAction {
        spec: spec("app_intent", "App : action", "Exécute n'importe quelle action déclarée par une app installée (identifiant d'app + d'action, arguments JSON). Les apps s'ouvrent en coulisse si besoin.", "Apps", "layout-grid",
            vec![
                p("app", "App", ParamKind::Text).required().placeholder("notes, carte, python…"),
                p("intent", "Action", ParamKind::Text).required().placeholder("create_note"),
                p("args", "Arguments JSON", ParamKind::Multiline).placeholder("{\"title\":\"…\"}"),
            ], true),
        run: Box::new(|params, _ctx| {
            let raw = param_text(params, "args");
            let args: serde_json::Value = if raw.trim().is_empty() { serde_json::json!({}) } else {
                serde_json::from_str(raw.trim()).map_err(|e| anyhow::anyhow!("Arguments JSON invalides : {e}"))?
            };
            let out = crate::lumen::post_json_timeout("/fluxo/intent", serde_json::json!({
                "app": param_text(params, "app").trim(), "intent": param_text(params, "intent").trim(), "args": args,
            }), 130)?;
            Ok(as_value(out))
        }),
    }));

    // ---- Domotique : mesures, comparaisons, thermostat, sonnette ----
    e.register(Arc::new(FnAction {
        spec: spec("domotique_read_value", "Domotique : lire une mesure", "Renvoie une mesure d'un objet sous forme de nombre (température, CO₂, PM2.5, présence = 1/0, fuite = 1/0…).", "Domotique", "gauge",
            vec![
                p("device", "Objet", ParamKind::Text).required().placeholder("Capteur salon"),
                p("field", "Mesure", select(FIELDS)),
                p("component", "Composant", ParamKind::Text).placeholder("vide = le premier qui porte la mesure"),
            ], true),
        run: Box::new(|params, _ctx| {
            let field = { let f = param_text(params, "field"); if f.trim().is_empty() { "temp".to_string() } else { f } };
            Ok(Value::Number(domotique_field(&param_text(params, "device"), &param_text(params, "component"), &field)?))
        }),
    }));
    e.register(Arc::new(FnAction {
        spec: spec("domotique_compare", "Domotique : condition sur une mesure", "Vrai si la mesure respecte la condition (ex. CO₂ > 1200, fuite = 1). À placer avant un « Si ».", "Domotique", "gauge",
            vec![
                p("device", "Objet", ParamKind::Text).required().placeholder("Capteur salon"),
                p("field", "Mesure", select(FIELDS)),
                p("op", "Opérateur", select(&[">", "<", ">=", "<=", "="])),
                p("value", "Seuil", ParamKind::Number),
                p("component", "Composant", ParamKind::Text).placeholder("facultatif"),
            ], true),
        run: Box::new(|params, _ctx| {
            let field = { let f = param_text(params, "field"); if f.trim().is_empty() { "temp".to_string() } else { f } };
            let v = domotique_field(&param_text(params, "device"), &param_text(params, "component"), &field)?;
            let t = params.get("value").and_then(|x| x.as_number()).unwrap_or(0.0);
            let ok = match param_text(params, "op").trim() {
                "<" => v < t, ">=" => v >= t, "<=" => v <= t, "=" => (v - t).abs() < 1e-9, _ => v > t,
            };
            Ok(Value::Bool(ok))
        }),
    }));
    e.register(Arc::new(FnAction {
        spec: spec("domotique_thermostat", "Domotique : régler le thermostat", "Change la consigne et/ou le mode d'un thermostat Lumen (la régulation tourne sur la carte).", "Domotique", "gauge",
            vec![
                p("device", "Objet", ParamKind::Text).required().placeholder("Thermostat salon"),
                p("setpoint", "Consigne (°C)", ParamKind::Number),
                p("mode", "Mode", select(&["", "heat", "off"])),
                p("component", "Composant", ParamKind::Text).placeholder("facultatif"),
            ], true),
        run: Box::new(|params, _ctx| {
            let mut prm = serde_json::Map::new();
            if let Some(sp) = params.get("setpoint").and_then(|x| x.as_number()) { if sp > 0.0 { prm.insert("setpoint".into(), serde_json::json!(sp)); } }
            let mode = param_text(params, "mode");
            if !mode.trim().is_empty() { prm.insert("mode".into(), serde_json::json!(mode.trim())); }
            if prm.is_empty() { anyhow::bail!("Indiquez une consigne ou un mode"); }
            let mut body = serde_json::json!({ "device": param_text(params, "device"), "action": "set", "params": prm });
            let comp = param_text(params, "component");
            if !comp.trim().is_empty() { body["component"] = serde_json::json!(comp.trim()); }
            Ok(as_value(crate::lumen::post_json("/domotique/cmd", body)?))
        }),
    }));
    e.register(Arc::new(FnAction {
        spec: spec("domotique_doorbell_photo", "Domotique : photo de la sonnette", "Prend une photo avec la caméra de la sonnette (ESP32-CAM) et l'enregistre en JPEG dans une sandbox. Renvoie le chemin.", "Domotique", "camera",
            vec![
                p("device", "Sonnette", ParamKind::Text).required().placeholder("Sonnette entrée"),
                p("sandbox", "Sandbox (id)", ParamKind::Text).placeholder("vide = première sandbox"),
                p("component", "Composant", ParamKind::Text).placeholder("facultatif"),
            ], true),
        run: Box::new(|params, _ctx| {
            let mut body = serde_json::json!({ "device": param_text(params, "device"), "action": "snapshot", "params": {} });
            let comp = param_text(params, "component");
            if !comp.trim().is_empty() { body["component"] = serde_json::json!(comp.trim()); }
            let raw = crate::lumen::post_json_timeout("/domotique/cmd", body, 20)?;
            let j: serde_json::Value = serde_json::from_str(raw.trim()).unwrap_or(serde_json::Value::Null);
            let jpeg = j.get("jpeg").or_else(|| j.get("result").and_then(|r| r.get("jpeg"))).and_then(|x| x.as_str())
                .ok_or_else(|| anyhow::anyhow!("Pas d'image : {raw}"))?;
            let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let path = format!("Sonnette/sonnette-{ts}.jpg");
            crate::lumen::post_json_timeout("/fluxo/native", serde_json::json!({
                "name": "sandbox_write_b64",
                "args": { "path": path, "b64": jpeg, "sandbox": param_text(params, "sandbox") },
            }), 30)?;
            Ok(Value::Text(path))
        }),
    }));
}
