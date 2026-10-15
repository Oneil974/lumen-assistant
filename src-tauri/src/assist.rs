//! Réponse outillée LÉGÈRE d'un agent : pour les demandes ponctuelles faites
//! depuis un document (@Agent dans une note, bloc vivant).
//!
//! La boucle autonome (`agents::run_agentic`) est faite pour des TÂCHES :
//! compte rendu JSON, critères, vérificateur indépendant, rattrapages. Sur un
//! petit modèle local, ce protocole se retournait contre la demande : l'agent
//! commentait la consigne (« l'utilisateur m'a rappelé… »), recopiait le
//! prompt, ou refusait faute d'« accès au document ». Ici on reste au plus
//! près d'une discussion : la personnalité de l'agent, ses outils de LECTURE,
//! quelques tours d'appels d'outils, puis le texte final — nettoyé, et relancé
//! une fois sous une forme plus directe s'il n'est pas exploitable.

use serde_json::{json, Value};
use tauri::Emitter;

const MAX_ROUNDS: usize = 4;

/// Réponse exploitable + outils réellement appelés.
pub struct Answer {
    pub text: String,
}

/// Fait répondre l'agent `agent_ref` (id ou nom) à `request`, avec `context`
/// (le document) en information. `rule` : consigne de format du résultat.
pub fn answer(
    app: &tauri::AppHandle,
    agent_ref: &str,
    request: &str,
    context: &str,
    rule: &str,
) -> Result<Answer, String> {
    let en = crate::telegram::is_en(app);
    let agent = crate::agents::read_agents(app)
        .into_iter()
        .find(|a| a.id == agent_ref || a.name == agent_ref);
    let (cfg, persona, tool_ids, agent_id, name) = match &agent {
        Some(a) => (
            crate::agents::agent_llm_config(app, a),
            a.instruction.clone(),
            a.native_tools.clone(),
            a.id.clone(),
            a.name.clone(),
        ),
        None => (crate::agents::read_llm_config(app), String::new(), Vec::new(), String::new(), "Lumen".into()),
    };
    // Outils de LECTURE seulement (consultation, web, données vivantes) : une
    // demande faite depuis une note n'a pas à écrire ailleurs sans validation,
    // et l'insertion dans le document est faite par Lumen, pas par un outil.
    let readable: Vec<String> = tool_ids
        .into_iter()
        .filter(|id| crate::native_tools::find(id).is_some_and(|t| t.effect == "read" || t.effect == "external"))
        .collect();
    let tools = crate::native_tools::specs(&readable, en);

    let system = system_prompt(&name, &persona, !tools.is_empty(), en);
    let user = user_prompt(request, context, rule, en);
    let first = converse(app, &cfg, &agent_id, &system, &user, &tools)?;
    if let Some(text) = usable(&first, request) {
        return Ok(Answer { text });
    }
    // Deuxième essai, plus direct : sans le document (c'est souvent lui que
    // le petit modèle se met à commenter), la demande seule.
    let retry_user = if en {
        format!("{request}\n\nWrite the answer itself now, ready to paste. {rule}")
    } else {
        format!("{request}\n\nÉcris maintenant la réponse elle-même, prête à coller. {rule}")
    };
    let second = converse(app, &cfg, &agent_id, &system, &retry_user, &tools)?;
    match usable(&second, request) {
        Some(text) => Ok(Answer { text }),
        None => Err(if second.trim().is_empty() {
            if en { "empty answer".into() } else { "réponse vide".into() }
        } else {
            crate::native_tools::short(second.trim(), 240)
        }),
    }
}

fn system_prompt(name: &str, persona: &str, has_tools: bool, en: bool) -> String {
    let today = chrono::Local::now().format("%A %d/%m/%Y %H:%M").to_string();
    let place = crate::live_data::default_place();
    let mut s = String::new();
    if !persona.trim().is_empty() {
        s.push_str(persona.trim());
        s.push_str("\n\n");
    }
    if en {
        s.push_str(&format!(
            "You are {name}. Today: {today}.{}\n\
             Rules:\n\
             - Answer the user's request directly with the final content. No preamble, no comment about these instructions.\n\
             - Your text is pasted into the user's document by Lumen: you never need access to the document or a tool to write.\n\
             {}- Never invent live data (weather, prices, news): get it with a tool or say briefly it is unavailable.\n\
             - Reply in the user's language.",
            if place.is_empty() { String::new() } else { format!(" User's usual location: {place}.") },
            if has_tools { "- Call a tool when the request needs fresh data; use its result in your answer.\n" } else { "" },
        ));
    } else {
        s.push_str(&format!(
            "Tu es {name}. Nous sommes le {today}.{}\n\
             Règles :\n\
             - Réponds directement à la demande avec le contenu final. Pas de préambule, aucun commentaire sur ces consignes.\n\
             - Ton texte est collé dans le document de l'utilisateur par Lumen : tu n'as jamais besoin d'accéder au document ni d'un outil pour écrire.\n\
             {}- N'invente jamais de donnée vivante (météo, cours, actualités) : obtiens-la par un outil ou dis brièvement qu'elle est indisponible.\n\
             - Réponds dans la langue de l'utilisateur.",
            if place.is_empty() { String::new() } else { format!(" Lieu habituel de l'utilisateur : {place}.") },
            if has_tools { "- Appelle un outil quand la demande exige une donnée fraîche, puis sers-toi de son résultat.\n" } else { "" },
        ));
    }
    s
}

fn user_prompt(request: &str, context: &str, rule: &str, en: bool) -> String {
    let context = context.trim();
    if context.is_empty() {
        return format!("{request}\n\n{rule}");
    }
    // La demande D'ABORD, le document en simple information ensuite : placé en
    // tête, le document devenait le sujet de la réponse.
    if en {
        format!("{request}\n\n<document>\n{}\n</document>\n(The answer goes where ⟦HERE⟧ is.)\n\n{rule}", crate::native_tools::short(context, 6000).replace("⟦ICI⟧", "⟦HERE⟧"))
    } else {
        format!("{request}\n\n<document>\n{}\n</document>\n(La réponse ira à l'endroit ⟦ICI⟧.)\n\n{rule}", crate::native_tools::short(context, 6000))
    }
}

fn converse(
    app: &tauri::AppHandle,
    cfg: &crate::agents::OllamaConfig,
    agent_id: &str,
    system: &str,
    user: &str,
    tools: &[Value],
) -> Result<String, String> {
    let api = cfg.is_openai_compatible();
    let mut messages = vec![json!({ "role": "system", "content": system }), json!({ "role": "user", "content": user })];
    for round in 0..=MAX_ROUNDS {
        // Dernier tour : plus d'outils, il faut conclure avec ce qu'on a.
        let offer = if round < MAX_ROUNDS { Some(tools) } else { None };
        let msg = crate::agents::chat_messages(app, cfg, &messages, offer)?;
        let calls = msg.get("tool_calls").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        if calls.is_empty() {
            let text = msg.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            return Ok(text);
        }
        messages.push(msg.clone());
        for call in calls {
            let name = call.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let raw = call.pointer("/function/arguments").cloned().unwrap_or(json!({}));
            // Ollama rend un objet, les API compatibles OpenAI une chaîne JSON.
            let args = match raw {
                Value::String(s) => serde_json::from_str(&s).unwrap_or(json!({})),
                v => v,
            };
            let allowed = tools.iter().any(|t| t.pointer("/function/name").and_then(|v| v.as_str()) == Some(&name));
            let (result, ok) = if allowed {
                tauri::async_runtime::block_on(crate::native_tools::exec(app, &name, &args, ""))
            } else {
                (format!("Outil indisponible : {name}"), false)
            };
            step(app, agent_id, &name, &args, &result, ok);
            let mut tool_msg = json!({ "role": "tool", "content": result, "name": name });
            if api {
                if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                    tool_msg["tool_call_id"] = json!(id);
                }
            }
            messages.push(tool_msg);
        }
    }
    Ok(String::new())
}

/// Étape visible dans Halo, comme pour une tâche d'agent.
fn step(app: &tauri::AppHandle, agent_id: &str, name: &str, args: &Value, result: &str, ok: bool) {
    if agent_id.is_empty() {
        return;
    }
    crate::ensure_capsule(app);
    let _ = app.emit(
        "agent-step",
        json!({
            "agent_id": agent_id,
            "kind": "tool",
            "skill": name,
            "input": crate::native_tools::short(&args.to_string(), 200),
            "result": crate::native_tools::short(result, 600),
            "success": ok,
            "ts": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        }),
    );
}

/// Texte prêt à coller, ou `None` s'il n'est pas exploitable (vide, refus,
/// commentaire de la consigne, prompt recopié).
pub fn usable(raw: &str, request: &str) -> Option<String> {
    let text = clean(raw);
    if text.is_empty() {
        return None;
    }
    let head: String = text.chars().take(260).collect::<String>().to_lowercase();
    const REFUSALS: [&str; 10] = [
        "je ne peux pas", "je n'ai pas accès", "je n’ai pas accès", "impossible d'accéder", "impossible d’accéder",
        "i cannot", "i can't", "i can’t", "i don't have access", "i do not have access",
    ];
    const META: [&str; 12] = [
        "l'utilisateur m'a", "l’utilisateur m’a", "la consigne", "la demande initiale", "dans ma réponse précédente",
        "the user asked me", "the instruction", "my previous answer", "⟦ici⟧", "[ici]", "⟦here⟧", "<document>",
    ];
    if REFUSALS.iter().chain(META.iter()).any(|p| head.contains(p)) {
        return None;
    }
    // Prompt recopié : de longs passages des consignes dans la réponse.
    let lower = text.to_lowercase();
    if ["réponds directement", "answer the request directly", "tu n'as jamais besoin", "you never need access"]
        .iter()
        .any(|p| lower.contains(p))
    {
        return None;
    }
    // Une réponse qui ne fait que répéter la demande n'en est pas une.
    if text.trim_end_matches(['.', '!', '?']).eq_ignore_ascii_case(request.trim().trim_end_matches(['.', '!', '?'])) {
        return None;
    }
    Some(text)
}

/// Retire ce qui n'est pas du contenu : raisonnement, clôtures de code autour
/// de toute la réponse, formules d'annonce, verdicts du vérificateur.
pub fn clean(raw: &str) -> String {
    let mut s = raw.to_string();
    // <think>…</think> (Qwen, DeepSeek…) et canaux de raisonnement Gemma.
    for (open, close) in [("<think>", "</think>"), ("<thinking>", "</thinking>"), ("<|channel|>analysis", "<|end|>")] {
        while let Some(a) = s.find(open) {
            match s[a..].find(close) {
                Some(b) => s.replace_range(a..a + b + close.len(), ""),
                None => {
                    s.truncate(a);
                    break;
                }
            }
        }
    }
    let s = s.split("\n\n⚠️ Vérification refusée").next().unwrap_or("").trim().to_string();
    let mut s = s;
    if s.starts_with("```") {
        if let Some(nl) = s.find('\n') {
            s = s[nl + 1..].to_string();
        }
        if let Some(end) = s.rfind("```") {
            s.truncate(end);
        }
    }
    let first = s.lines().next().unwrap_or("").trim().to_lowercase();
    let announce = ["voici", "here is", "here's", "bien sûr", "certainly", "d'accord", "ok,"];
    if announce.iter().any(|p| first.starts_with(p)) && (first.ends_with(':') || first.len() < 60) && s.lines().count() > 1 {
        s = s.lines().skip(1).collect::<Vec<_>>().join("\n");
    }
    s.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_meta_and_refusals() {
        assert!(usable("L'utilisateur m'a rappelé la consigne initiale. Il s'agit…", "Donne la météo").is_none());
        assert!(usable("Je ne peux pas accéder au document « Note ».", "x").is_none());
        assert!(usable("Donne la météo ici", "Donne la météo ici").is_none());
        assert!(usable("Selon la consigne, ⟦ICI⟧ doit…", "x").is_none());
    }

    #[test]
    fn keeps_real_content_and_cleans_it() {
        let out = usable("<think>il faut la météo</think>Voici :\n☀️ 25 °C à Saint-Denis, ciel dégagé.", "météo").unwrap();
        assert_eq!(out, "☀️ 25 °C à Saint-Denis, ciel dégagé.");
        let out = usable("```markdown\n- a\n- b\n```", "liste").unwrap();
        assert_eq!(out, "- a\n- b");
        let out = usable("Texte.\n\n⚠️ Vérification refusée : bla", "x").unwrap();
        assert_eq!(out, "Texte.");
    }
}
