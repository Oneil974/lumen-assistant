// Génération en flux (streaming) pour TOUS les backends de Lumen.
//
// Jusqu'ici chaque appel passait par un proxy « agrégé » (llama_post_json,
// litert_post_json, llm_api_request, ollama_post_json) : la WebView attendait
// la réponse complète avant d'afficher quoi que ce soit. Cette commande ouvre
// la requête en `stream: true`, relaie au front des évènements NORMALISÉS via
// un `Channel` Tauri, puis renvoie la réponse agrégée dans la forme exacte des
// anciens proxys — l'appelant peut donc remplacer l'un par l'autre sans rien
// changer à son traitement final (outils, jetons, Profiler).
//
// Évènements envoyés au front (un objet JSON par évènement) :
//   { t: "content",   d: "<delta de texte>" }
//   { t: "reasoning", d: "<delta de raisonnement>" }
//   { t: "tool", i: <index>, name: "<nom>", args: "<arguments cumulés>" }
//   { t: "wait", d: "loading" }   serveur qui charge son modèle (503)
//
// La clé API ne quitte jamais le backend (même résolution que llm_api_request).

use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::Manager;

/// Identifiants des flux dont le front a demandé l'arrêt (bouton Stop).
static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn is_cancelled(id: &str) -> bool {
    !id.is_empty()
        && CANCELLED.lock().ok().and_then(|g| g.as_ref().map(|s| s.contains(id))).unwrap_or(false)
}

fn clear_cancel(id: &str) {
    if let Ok(mut g) = CANCELLED.lock() {
        if let Some(s) = g.as_mut() {
            s.remove(id);
        }
    }
}

#[tauri::command]
pub fn llm_stream_cancel(id: String) {
    if let Ok(mut g) = CANCELLED.lock() {
        g.get_or_insert_with(HashSet::new).insert(id);
    }
}

/// Appel d'outil en cours d'assemblage (les deltas OpenAI arrivent par index).
#[derive(Default, Clone)]
struct ToolAcc {
    id: String,
    name: String,
    args: String,
    // Ollama livre des arguments déjà objets : on les garde tels quels.
    args_obj: Option<Value>,
}

#[derive(Default)]
struct Acc {
    content: String,
    reasoning: String,
    tools: Vec<ToolAcc>,
    finish: Option<String>,
    usage: Option<Value>,
    timings: Option<Value>,
    model: Option<String>,
    // Chunk final d'Ollama (eval_count, durées…).
    ollama_final: Option<Map<String, Value>>,
}

/// Destination des évènements : le `Channel` Tauri en production, un
/// collecteur dans les tests.
type Sink<'a> = &'a (dyn Fn(Value) + Send + Sync);

fn send(ch: Sink, v: Value) {
    ch(v);
}

/// Traite un chunk OpenAI (`chat.completion.chunk`) — llama.cpp, LiteRT, cloud.
fn on_openai_chunk(v: &Value, acc: &mut Acc, ch: Sink) {
    if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
        acc.usage = Some(u.clone());
    }
    if let Some(t) = v.get("timings").filter(|t| !t.is_null()) {
        acc.timings = Some(t.clone());
    }
    if let Some(m) = v.get("model").and_then(|m| m.as_str()) {
        acc.model = Some(m.to_string());
    }
    let Some(choice) = v.get("choices").and_then(|c| c.get(0)) else { return };
    if let Some(f) = choice.get("finish_reason").and_then(|f| f.as_str()) {
        acc.finish = Some(f.to_string());
    }
    // Un serveur qui ignore `stream` renvoie `message` au lieu de `delta`.
    let delta = choice.get("delta").or_else(|| choice.get("message"));
    let Some(delta) = delta else { return };
    for key in ["reasoning_content", "reasoning", "thinking"] {
        if let Some(r) = delta.get(key).and_then(|r| r.as_str()).filter(|r| !r.is_empty()) {
            acc.reasoning.push_str(r);
            send(ch, json!({ "t": "reasoning", "d": r }));
            break;
        }
    }
    if let Some(c) = delta.get("content").and_then(|c| c.as_str()).filter(|c| !c.is_empty()) {
        acc.content.push_str(c);
        send(ch, json!({ "t": "content", "d": c }));
    }
    if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
        for (pos, call) in calls.iter().enumerate() {
            let idx = call.get("index").and_then(|i| i.as_u64()).map(|i| i as usize).unwrap_or(pos);
            while acc.tools.len() <= idx {
                acc.tools.push(ToolAcc::default());
            }
            let slot = &mut acc.tools[idx];
            if let Some(id) = call.get("id").and_then(|i| i.as_str()) {
                slot.id = id.to_string();
            }
            if let Some(f) = call.get("function") {
                if let Some(n) = f.get("name").and_then(|n| n.as_str()) {
                    // Certains serveurs répètent le nom à chaque delta.
                    if slot.name != n {
                        slot.name.push_str(n);
                    }
                }
                match f.get("arguments") {
                    Some(Value::String(a)) => slot.args.push_str(a),
                    Some(o @ Value::Object(_)) => slot.args_obj = Some(o.clone()),
                    _ => {}
                }
            }
            send(ch, json!({ "t": "tool", "i": idx, "name": slot.name, "args": slot.args }));
        }
    }
}

/// Traite une ligne NDJSON d'Ollama natif (/api/chat).
fn on_ollama_line(v: &Value, acc: &mut Acc, ch: Sink) {
    if let Some(m) = v.get("model").and_then(|m| m.as_str()) {
        acc.model = Some(m.to_string());
    }
    if let Some(msg) = v.get("message") {
        if let Some(r) = msg.get("thinking").and_then(|r| r.as_str()).filter(|r| !r.is_empty()) {
            acc.reasoning.push_str(r);
            send(ch, json!({ "t": "reasoning", "d": r }));
        }
        if let Some(c) = msg.get("content").and_then(|c| c.as_str()).filter(|c| !c.is_empty()) {
            acc.content.push_str(c);
            send(ch, json!({ "t": "content", "d": c }));
        }
        if let Some(calls) = msg.get("tool_calls").and_then(|c| c.as_array()) {
            for call in calls {
                let f = call.get("function").cloned().unwrap_or(Value::Null);
                let name = f.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                let args_obj = f.get("arguments").cloned();
                let args = args_obj.as_ref().map(|a| a.to_string()).unwrap_or_default();
                let idx = acc.tools.len();
                acc.tools.push(ToolAcc { id: String::new(), name: name.clone(), args: args.clone(), args_obj });
                send(ch, json!({ "t": "tool", "i": idx, "name": name, "args": args }));
            }
        }
    }
    if v.get("done").and_then(|d| d.as_bool()) == Some(true) {
        if let Some(obj) = v.as_object() {
            acc.ollama_final = Some(obj.clone());
        }
    }
}

fn openai_result(acc: Acc, cancelled: bool) -> Value {
    let mut message = json!({ "role": "assistant", "content": acc.content });
    if !acc.reasoning.is_empty() {
        message["reasoning_content"] = Value::String(acc.reasoning);
    }
    let calls: Vec<Value> = acc
        .tools
        .iter()
        .enumerate()
        .filter(|(_, t)| !t.name.is_empty())
        .map(|(i, t)| {
            let args = match &t.args_obj {
                Some(o) if t.args.is_empty() => o.to_string(),
                _ => t.args.clone(),
            };
            json!({
                "id": if t.id.is_empty() { format!("call_{i}") } else { t.id.clone() },
                "type": "function",
                "function": { "name": t.name, "arguments": args },
            })
        })
        .collect();
    if !calls.is_empty() {
        message["tool_calls"] = Value::Array(calls);
    }
    let mut out = json!({
        "object": "chat.completion",
        "choices": [{ "index": 0, "message": message, "finish_reason": acc.finish.unwrap_or_else(|| "stop".into()) }],
    });
    if let Some(m) = acc.model { out["model"] = Value::String(m); }
    if let Some(u) = acc.usage { out["usage"] = u; }
    if let Some(t) = acc.timings { out["timings"] = t; }
    if cancelled { out["cancelled"] = Value::Bool(true); }
    out
}

fn ollama_result(acc: Acc, cancelled: bool) -> Value {
    let mut out = Value::Object(acc.ollama_final.unwrap_or_default());
    let mut message = json!({ "role": "assistant", "content": acc.content });
    if !acc.reasoning.is_empty() {
        message["thinking"] = Value::String(acc.reasoning);
    }
    let calls: Vec<Value> = acc
        .tools
        .iter()
        .map(|t| json!({ "function": { "name": t.name, "arguments": t.args_obj.clone().unwrap_or_else(|| serde_json::from_str(&t.args).unwrap_or(json!({}))) } }))
        .collect();
    if !calls.is_empty() {
        message["tool_calls"] = Value::Array(calls);
    }
    out["message"] = message;
    out["done"] = Value::Bool(true);
    if let Some(m) = acc.model { out["model"] = Value::String(m); }
    if cancelled { out["cancelled"] = Value::Bool(true); }
    out
}

/// Les messages d'historique portent des champs propres à Lumen (notes
/// d'outils, cartes, raisonnement replié…) : un fournisseur cloud strict les
/// refuserait. On ne garde que le contrat OpenAI.
fn strip_private_keys(payload: &mut Value) {
    const KEEP: [&str; 6] = ["role", "content", "name", "tool_calls", "tool_call_id", "refusal"];
    if let Some(msgs) = payload.get_mut("messages").and_then(|m| m.as_array_mut()) {
        for m in msgs {
            if let Some(obj) = m.as_object_mut() {
                obj.retain(|k, _| KEEP.contains(&k.as_str()));
            }
        }
    }
}

/// Envoie la requête, en réessayant tant que le serveur local répond 503 (il
/// mappe son modèle) — même politique que les proxys agrégés.
async fn send_with_retry(
    rb: impl Fn() -> reqwest::RequestBuilder,
    label: &str,
    retry_503: bool,
    ch: Sink<'_>,
    id: &str,
) -> Result<reqwest::Response, String> {
    let mut last = format!("{label} indisponible");
    let tries = if retry_503 { 120 } else { 1 };
    for _ in 0..tries {
        if is_cancelled(id) {
            return Err("Génération interrompue".into());
        }
        match rb().send().await {
            Ok(r) if r.status().is_success() => return Ok(r),
            Ok(r) => {
                let status = r.status();
                let detail = r.text().await.unwrap_or_default();
                let detail = detail.trim();
                last = if detail.is_empty() {
                    format!("{label} HTTP {status}")
                } else {
                    format!("{label} HTTP {status}: {}", detail.chars().take(500).collect::<String>())
                };
                if status.as_u16() != 503 {
                    return Err(last);
                }
                send(ch, json!({ "t": "wait", "d": "loading" }));
            }
            Err(e) => last = format!("{label} : {e}"),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(last)
}

/// Lit le corps ligne par ligne (SSE `data: …` ou NDJSON) jusqu'à la fin.
/// Renvoie vrai si le flux a été interrompu par l'utilisateur.
async fn pump(
    mut resp: reqwest::Response,
    id: &str,
    mut on_json: impl FnMut(&Value),
) -> Result<bool, String> {
    // Serveur qui ignore `stream` : un seul JSON complet.
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ctype.starts_with("application/json") {
        let v: Value = resp.json().await.map_err(|e| format!("Réponse IA illisible : {e}"))?;
        on_json(&v);
        return Ok(false);
    }
    let mut buf: Vec<u8> = Vec::new();
    let handle_line = |line: &[u8], on_json: &mut dyn FnMut(&Value)| {
        let text = String::from_utf8_lossy(line);
        let text = text.trim();
        if text.is_empty() || text.starts_with(':') || text.starts_with("event:") {
            return;
        }
        let data = text.strip_prefix("data:").map(str::trim).unwrap_or(text);
        if data == "[DONE]" {
            return;
        }
        if let Ok(v) = serde_json::from_str::<Value>(data) {
            on_json(&v);
        }
    };
    loop {
        if is_cancelled(id) {
            return Ok(true);
        }
        let chunk = resp.chunk().await.map_err(|e| format!("Flux interrompu : {e}"))?;
        let Some(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            handle_line(&line, &mut on_json);
        }
    }
    if !buf.is_empty() {
        let rest = std::mem::take(&mut buf);
        handle_line(&rest, &mut on_json);
    }
    Ok(false)
}

/// Génère en flux. `target` : « llama », « litert », « api » (cloud, Lumen
/// Server, Apple FM — résolus par `backend`) ou « ollama » (API native).
/// Renvoie la réponse agrégée au format du proxy correspondant.
#[tauri::command]
pub async fn llm_stream(
    app: tauri::AppHandle,
    id: Option<String>,
    target: String,
    payload: Value,
    url: Option<String>,
    backend: Option<String>,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    let id = id.unwrap_or_default();
    let sink = move |v: Value| { let _ = on_event.send(v); };
    let result = run(&app, &id, &target, payload, url, backend, &sink).await;
    clear_cancel(&id);
    result
}

async fn run(
    app: &tauri::AppHandle,
    id: &str,
    target: &str,
    mut payload: Value,
    url: Option<String>,
    backend: Option<String>,
    ch: Sink<'_>,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // Pas de délai global (une longue réponse peut durer des minutes) :
        // on borne seulement le silence entre deux paquets.
        .read_timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("stream".into(), Value::Bool(true));
    }
    let mut acc = Acc::default();
    match target {
        "ollama" => {
            let base = crate::normalize_ollama_url(url.as_deref().unwrap_or("http://127.0.0.1:11434"));
            let endpoint = format!("{base}/api/chat");
            let resp = send_with_retry(|| client.post(&endpoint).json(&payload), "Ollama", false, ch, id).await?;
            let cancelled = pump(resp, id, |v| on_ollama_line(v, &mut acc, ch)).await?;
            Ok(ollama_result(acc, cancelled))
        }
        "llama" | "litert" => {
            let model = payload.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
            let (port, label) = if target == "llama" {
                if !model.is_empty() {
                    let _ = crate::llama::ensure_running_for(app, &model).await;
                }
                (crate::llama::PORT, "llama-server")
            } else {
                if !model.is_empty() {
                    let state = app.state::<crate::litert::LitertState>();
                    crate::litert::ensure_running(app, &state, &model).await?;
                }
                (crate::litert::PORT, "litert-lm")
            };
            if target == "llama" {
                if let Some(obj) = payload.as_object_mut() {
                    // Métriques de fin (timings + usage) dans le dernier chunk.
                    obj.insert("stream_options".into(), json!({ "include_usage": true }));
                }
            }
            let endpoint = format!("http://127.0.0.1:{port}/v1/chat/completions");
            let resp = send_with_retry(|| client.post(&endpoint).json(&payload), label, true, ch, id).await?;
            let cancelled = pump(resp, id, |v| on_openai_chunk(v, &mut acc, ch)).await?;
            Ok(openai_result(acc, cancelled))
        }
        "api" => {
            let (endpoint, key, force_model, cfg_model) =
                crate::agents::resolve_api_target(app, backend.as_deref(), "chat/completions")?;
            if let Some(obj) = payload.as_object_mut() {
                if let Some(m) = force_model.as_deref().filter(|m| !m.trim().is_empty()) {
                    obj.insert("model".into(), Value::String(m.to_string()));
                }
            }
            let model = payload.get("model").and_then(|m| m.as_str()).unwrap_or(&cfg_model).to_string();
            crate::agents::apply_openai_tool_compat(&mut payload, &model);
            strip_private_keys(&mut payload);
            let mut with_usage = payload.clone();
            if let Some(obj) = with_usage.as_object_mut() {
                obj.insert("stream_options".into(), json!({ "include_usage": true }));
            }
            // `stream_options` est refusé par quelques fournisseurs : on retente
            // alors sans, plutôt que d'échouer pour un simple compteur.
            let resp = match send_with_retry(|| client.post(&endpoint).bearer_auth(&key).json(&with_usage), "Appel IA échoué :", false, ch, id).await {
                Ok(r) => r,
                Err(e) if e.contains("HTTP 400") || e.contains("HTTP 422") => {
                    send_with_retry(|| client.post(&endpoint).bearer_auth(&key).json(&payload), "Appel IA échoué :", false, ch, id).await?
                }
                Err(e) => return Err(e),
            };
            let cancelled = pump(resp, id, |v| on_openai_chunk(v, &mut acc, ch)).await?;
            Ok(openai_result(acc, cancelled))
        }
        other => Err(format!("Cible de flux inconnue : {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::io::AsyncWriteExt;

    /// Mini serveur HTTP : renvoie `body` découpé en morceaux de 7 octets (les
    /// lignes SSE/NDJSON sont donc coupées n'importe où, comme sur le réseau).
    async fn serve(content_type: &'static str, body: String) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n");
            sock.write_all(head.as_bytes()).await.unwrap();
            for part in body.as_bytes().chunks(7) {
                sock.write_all(part).await.unwrap();
                sock.flush().await.unwrap();
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        });
        format!("http://{addr}/")
    }

    fn collector() -> (Arc<StdMutex<Vec<Value>>>, impl Fn(Value) + Send + Sync) {
        let events = Arc::new(StdMutex::new(Vec::new()));
        let e2 = events.clone();
        (events, move |v: Value| e2.lock().unwrap().push(v))
    }

    #[tokio::test]
    async fn openai_sse_agrege_texte_raisonnement_outils() {
        let chunks = [
            json!({"choices":[{"delta":{"reasoning_content":"Je "}}]}),
            json!({"choices":[{"delta":{"reasoning_content":"réfléchis."}}]}),
            json!({"choices":[{"delta":{"content":"Bonjour "}}]}),
            json!({"choices":[{"delta":{"content":"à toi — é"}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"weather_now","arguments":"{\"pla"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ce\":\"Lyon\"}"}}]}}]}),
            json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5},"timings":{"predicted_n":5}}),
        ];
        let mut body = String::new();
        for c in &chunks { body.push_str(&format!("data: {c}\n\n")); }
        body.push_str("data: [DONE]\n\n");
        let url = serve("text/event-stream", body).await;
        let resp = reqwest::Client::new().get(&url).send().await.unwrap();
        let (events, sink) = collector();
        let mut acc = Acc::default();
        let cancelled = pump(resp, "", |v| on_openai_chunk(v, &mut acc, &sink)).await.unwrap();
        assert!(!cancelled);
        let out = openai_result(acc, false);
        let msg = &out["choices"][0]["message"];
        assert_eq!(msg["content"], "Bonjour à toi — é");
        assert_eq!(msg["reasoning_content"], "Je réfléchis.");
        assert_eq!(msg["tool_calls"][0]["id"], "call_a");
        assert_eq!(msg["tool_calls"][0]["function"]["name"], "weather_now");
        assert_eq!(msg["tool_calls"][0]["function"]["arguments"], "{\"place\":\"Lyon\"}");
        assert_eq!(out["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(out["usage"]["completion_tokens"], 5);
        let ev = events.lock().unwrap();
        assert!(ev.iter().any(|e| e["t"] == "reasoning"));
        assert!(ev.iter().any(|e| e["t"] == "tool" && e["args"] == "{\"place\":\"Lyon\"}"));
    }

    #[tokio::test]
    async fn ollama_ndjson_agrege() {
        let lines = [
            json!({"model":"m","message":{"role":"assistant","content":"","thinking":"hmm"},"done":false}),
            json!({"model":"m","message":{"role":"assistant","content":"Salut"},"done":false}),
            json!({"model":"m","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"memory_recall","arguments":{"query":"chat"}}}]},"done":false}),
            json!({"model":"m","message":{"role":"assistant","content":""},"done":true,"eval_count":7,"eval_duration":1000}),
        ];
        let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
        let url = serve("application/x-ndjson", body).await;
        let resp = reqwest::Client::new().get(&url).send().await.unwrap();
        let (_events, sink) = collector();
        let mut acc = Acc::default();
        pump(resp, "", |v| on_ollama_line(v, &mut acc, &sink)).await.unwrap();
        let out = ollama_result(acc, false);
        assert_eq!(out["message"]["content"], "Salut");
        assert_eq!(out["message"]["thinking"], "hmm");
        assert_eq!(out["message"]["tool_calls"][0]["function"]["arguments"]["query"], "chat");
        assert_eq!(out["eval_count"], 7);
        assert_eq!(out["done"], true);
    }

    #[tokio::test]
    async fn serveur_sans_flux_json_complet() {
        let body = json!({"choices":[{"message":{"role":"assistant","content":"Réponse entière"},"finish_reason":"stop"}]}).to_string();
        let url = serve("application/json", body).await;
        let resp = reqwest::Client::new().get(&url).send().await.unwrap();
        let (events, sink) = collector();
        let mut acc = Acc::default();
        pump(resp, "", |v| on_openai_chunk(v, &mut acc, &sink)).await.unwrap();
        assert_eq!(openai_result(acc, false)["choices"][0]["message"]["content"], "Réponse entière");
        assert_eq!(events.lock().unwrap().len(), 1);
    }

    #[test]
    fn cles_privees_retirees() {
        let mut p = json!({"messages":[{"role":"assistant","content":"x","toolNotes":[1],"reasoning":"r","cards":[]}]});
        strip_private_keys(&mut p);
        assert_eq!(p["messages"][0], json!({"role":"assistant","content":"x"}));
    }
}
