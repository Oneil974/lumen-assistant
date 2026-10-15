//! Chat is an adapter of the autonomous-agent loop. Only inference and UI-owned
//! tools cross the channel; task state, budgets and receipts stay in Rust/SQLite.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, AtomicU64, Ordering}, mpsc};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::Manager;

static BRIDGES: OnceLock<Mutex<HashMap<String, Arc<Bridge>>>> = OnceLock::new();
fn bridges() -> &'static Mutex<HashMap<String, Arc<Bridge>>> { BRIDGES.get_or_init(Default::default) }
pub struct Bridge {
    pub tools: Vec<Value>,
    pub context_tokens: u64,
    selected: Mutex<Vec<Value>>,
    tool_budget: usize,
    pub history: Vec<Value>,
    pub images: Vec<String>,
    pub cancelled: AtomicBool,
    owner: String,
    profile: String,
    channel: Channel<Value>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    seq: AtomicU64,
}
impl Bridge {
    pub fn request(&self, mut event: Value) -> Result<Value,String> {
        if self.cancelled.load(Ordering::Relaxed) { return Err("Tâche annulée.".into()); }
        let id = self.seq.fetch_add(1,Ordering::Relaxed);
        let (tx,rx)=mpsc::channel();
        self.pending.lock().map_err(|e|e.to_string())?.insert(id,tx);
        event["id"]=json!(id);
        let timeout=if event["kind"]=="tool" {1800} else {300};
        let result = (|| {
            self.channel.send(event).map_err(|e|e.to_string())?;
            let started=Instant::now();
            loop {
                if self.cancelled.load(Ordering::Relaxed) { return Err("Tâche annulée.".into()); }
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(v) => return if let Some(e)=v.get("error").and_then(Value::as_str) { Err(e.into()) } else { Ok(v) },
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Err("Interface déconnectée.".into()),
                    Err(_) if started.elapsed()>Duration::from_secs(timeout) => return Err("Interface sans réponse ; résultat de l'opération inconnu.".into()),
                    Err(_) => {},
                }
            }
        })();
        self.pending.lock().map_err(|e|e.to_string())?.remove(&id);
        result
    }
    pub fn text(&self, kind: &str, system: &str, user: &str) -> Result<String,String> {
        let v=self.request(json!({"kind":kind,"messages":[{"role":"system","content":system},{"role":"user","content":user}]}))?;
        Ok(v["content"].as_str().unwrap_or("").into())
    }
    pub fn read_only(&self,name:&str)->bool {
        if matches!(name,"lumen_find_tools"|"lumen_read_receipt") {return true;}
        self.tools.iter().find(|t|t["function"]["name"]==name).is_some_and(|t|t["lumen_read_only"]==true)
    }
    pub fn select_tools(&self, query: &str) -> Vec<Value> {
        let words=query.to_lowercase().split(|c:char|!c.is_alphanumeric()).filter(|w|w.len()>2).map(str::to_owned).collect::<Vec<_>>();
        let mut ranked=self.tools.clone();
        ranked.sort_by_key(|t| {
            let description=format!("{} {}",t["function"]["name"],t["function"]["description"]).to_lowercase();
            std::cmp::Reverse(words.iter().filter(|w|description.contains(w.as_str())).count())
        });
        let mut selected=Vec::new(); let mut size=0;
        for tool in ranked {
            let schema=json!({"type":"function","function":tool["function"]});
            let cost=schema.to_string().chars().count();
            if size+cost>self.tool_budget || selected.len()>=16 {continue;}
            size+=cost; selected.push(schema);
        }
        if let Ok(mut current)=self.selected.lock() {*current=selected.clone();}
        selected
    }
    pub fn schemas(&self)->Vec<Value> {
        let mut selected=self.selected.lock().map(|s|s.clone()).unwrap_or_default();
        selected.push(json!({"type":"function","function":{"name":"lumen_find_tools","description":"Cherche les outils autorisés par objectif ou nom et les rend disponibles au tour suivant. À utiliser si le bon outil manque.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}}));
        selected.push(json!({"type":"function","function":{"name":"lumen_read_receipt","description":"Relit le résultat intégral d'une opération de cette tâche, par pages. Utile après compaction.","parameters":{"type":"object","properties":{"operation":{"type":"string"},"offset":{"type":"integer"},"limit":{"type":"integer"}},"required":["operation"]}}}));
        selected
    }

}
#[derive(Deserialize)]
pub struct Request {
    pub session: String,
    pub turn: String,
    pub query: String,
    #[serde(default)] pub history: Vec<Value>,
    #[serde(default)] pub images: Vec<String>,
    #[serde(default)] pub tools: Vec<Value>,
    #[serde(default)] pub criteria: Vec<String>,
    #[serde(default)] pub resume: bool,
    #[serde(default)] pub context_tokens: u64,
    #[serde(default)] pub max_iterations: u64,
}
fn owner(window:&tauri::WebviewWindow)->Result<String,String> {
    // These adapters execute UI-owned tools, so only Lumen's trusted shells
    // may register them. Installed applications cannot impersonate a shell.
    let label=window.label();
    if !matches!(label,"main"|"sandbox-explorer") { return Err("Runtime réservé aux discussions Lumen.".into()); }
    Ok(label.into())
}
#[tauri::command]
pub fn chat_runtime_reply(window:tauri::WebviewWindow, token:String, id:u64, value:Value)->Result<(),String> {
    let who=owner(&window)?;
    let map=bridges().lock().map_err(|e|e.to_string())?;
    let b=map.get(&token).ok_or("Exécution terminée.")?;
    if b.owner!=who { return Err("Autre fenêtre propriétaire.".into()); }
    let tx=b.pending.lock().map_err(|e|e.to_string())?.remove(&id).ok_or("Réponse périmée.")?;
    tx.send(value).map_err(|e|e.to_string())
}
#[tauri::command]
pub fn chat_runtime_cancel(window:tauri::WebviewWindow, token:String)->Result<(),String> {
    let who=owner(&window)?;
    if let Some(b)=bridges().lock().map_err(|e|e.to_string())?.get(&token) {
        if b.owner!=who { return Err("Autre fenêtre propriétaire.".into()); }
        b.cancelled.store(true,Ordering::Relaxed);
    }
    Ok(())
}
#[tauri::command]
pub async fn chat_runtime_run(app:tauri::AppHandle, window:tauri::WebviewWindow, request:Request, on_event:Channel<Value>)->Result<Value,String> {
    let who=owner(&window)?;
    // La barre (fenêtre « main ») n'est pas Lumen OS : comme Telegram, elle doit
    // répondre bureau verrouillé. Le cloisonnement reste assuré outil par outil
    // (sandboxes, coffre… exigent toujours la session). Les autres fenêtres
    // (bureau et ses apps) gardent le contrôle de session.
    if window.label() != "main" {
        crate::session::require_unlocked(&app, app.state::<crate::session::SessionState>().inner())?;
    }
    if request.session.is_empty() || request.query.trim().is_empty() || request.tools.len()>500 { return Err("Demande invalide.".into()); }
    let mut random=[0u8;16]; getrandom::getrandom(&mut random).map_err(|e|e.to_string())?;
    let token=random.iter().map(|b|format!("{b:02x}")).collect::<String>();
    let profile=format!("{:?}",crate::session::active_profile_id(&app));
    let bridge=Arc::new(Bridge {tools:request.tools.clone(),context_tokens:if request.context_tokens>0 {request.context_tokens} else {8192},selected:Mutex::new(Vec::new()),tool_budget:((if request.context_tokens>0 {request.context_tokens} else {8192}) as usize * 3 / 4).saturating_sub(1200),history:request.history.clone(),images:request.images.clone(),cancelled:AtomicBool::new(false),owner:who,profile,channel:on_event,pending:Mutex::new(HashMap::new()),seq:AtomicU64::new(1)});
    bridge.select_tools(&request.query);
    bridges().lock().map_err(|e|e.to_string())?.insert(token.clone(),bridge.clone());
    if let Err(e)=bridge.channel.send(json!({"kind":"started","token":token})) {
        bridges().lock().map_err(|e|e.to_string())?.remove(&token);
        return Err(e.to_string());
    }
    let result=tauri::async_runtime::spawn_blocking(move || run(&app,request,bridge)).await.map_err(|e|e.to_string());
    bridges().lock().map_err(|e|e.to_string())?.remove(&token);
    result?
}
// Release the lease even on a transport/storage error or panic; the checkpoint
// and write-ahead receipt remain available for an explicit continuation.
struct LeaseGuard<'a> {app:&'a tauri::AppHandle, claim:crate::agent_runtime::Claim, closed:bool}
impl Drop for LeaseGuard<'_> {
    fn drop(&mut self) {
        if !self.closed {crate::agent_runtime::release_for_escalation(self.app,&self.claim,"Exécution interrompue ; reprise disponible.");}
    }
}
fn run(app:&tauri::AppHandle,r:Request,bridge:Arc<Bridge>)->Result<Value,String> {
    use crate::agents::{RunOpts,RunOutcome};
    use sha2::{Digest,Sha256};
    if bridge.profile != format!("{:?}",crate::session::active_profile_id(app)) {return Err("La session utilisateur a changé.".into());}
    let scope=format!("chat:{:x}",Sha256::digest(format!("{}:{}",bridge.profile,r.session).as_bytes()));
    let saved=crate::agents::get_run(app,&scope);
    let resume=if r.resume { saved } else { saved.filter(|s|s.task_id==format!("{scope}:{}",r.turn) && s.task==r.query) };
    let task=resume.as_ref().map(|s|s.task.clone()).unwrap_or(r.query);
    bridge.select_tools(&task);
    let task_id=resume.as_ref().map(|s|s.task_id.clone()).unwrap_or(format!("{scope}:{}",r.turn));
    if r.resume && resume.is_some() {
        crate::agent_runtime::conn(app)?.execute("UPDATE tasks SET retry_after=NULL WHERE task_id=?1 AND status != 'running'",[&task_id]).map_err(|e|e.to_string())?;
    }
    let claim=crate::agent_runtime::claim(app,&scope,&task_id,&task,None)?;
    let mut lease=LeaseGuard {app,claim:claim.clone(),closed:false};
    let mut cfg=crate::agents::read_llm_config(app);
    // Inference is delegated to the SAME configured frontend transport, so
    // Apple FM, local engines and API credentials keep their existing behavior.
    cfg.model="chat-adapter".into(); cfg.api_model="chat-adapter".into();
    let opts=RunOpts { agent_name:"Lumen".into(),orchestrator:false,can_create_skills:false,max_iterations:if r.max_iterations==0 {24} else {r.max_iterations.clamp(2,64)},max_tokens:0,num_ctx:r.context_tokens,depth:0,persist:true,task_id:task_id.clone(),claim:claim.clone(),parent_run_id:None,acceptance_criteria:r.criteria,allowed_effects:vec![],require_approval_for:vec![],mcp_servers:vec![],native_tools:vec![],sandbox_id:String::new(),bridge:Some(bridge.clone()) };
    let mut resume=resume;
    // An explicit continuation re-arms a budget, but keeps the transcript and
    // receipt sequence (iterations themselves are never reused).
    let prior_iterations=resume.as_ref().map(|s|s.iterations).unwrap_or(0);
    let opts=RunOpts { max_iterations:opts.max_iterations+prior_iterations,..opts };
    if let Some(s)=&mut resume {s.status="running".into();}
    let outcome=crate::agents::run_agentic(app,&scope,&crate::fluxo_engine_for(app),&cfg,"Accomplis la demande de l'utilisateur. Adapte le plan aux observations et vérifie les effets avant de conclure.",&task,&[],&None,&opts,resume);
    let (text,success,paused)=match outcome {RunOutcome::Final(t,ok)=>(t,ok,false),RunOutcome::Escalated(t)=>(t,false,true)};
    let receipts=crate::execution::receipts(app,&task_id)?;
    if paused {crate::agent_runtime::release_for_escalation(app,&claim,&text);}
    else {crate::agent_runtime::finish(app,&claim,success,&json!({"text":text,"success":success}),if success {""} else {&text})?;}
    lease.closed=true;
    if success || bridge.cancelled.load(Ordering::Relaxed) { crate::agents::clear_run(app,&scope); }
    Ok(json!({"text":text,"success":success,"paused":paused,"runId":claim.run_id,"receipts":receipts}))
}
