//! Shared durable state for chat and autonomous agents. Tool intents are saved
//! BEFORE effects; an interrupted effect is never silently executed twice.
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS execution_checkpoints(
    scope TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL
); CREATE TABLE IF NOT EXISTS execution_receipts(
    task_id TEXT NOT NULL, operation_id TEXT NOT NULL, name TEXT NOT NULL,
    args_json TEXT NOT NULL, result TEXT, success INTEGER,
    PRIMARY KEY(task_id, operation_id)
);";

pub fn load(app: &tauri::AppHandle, scope: &str) -> Result<Option<Value>, String> {
    crate::agent_runtime::init(app)?;
    let c = crate::agent_runtime::conn(app)?;
    let raw: Option<String> = c.query_row("SELECT state_json FROM execution_checkpoints WHERE scope=?1", [scope], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    raw.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string())).transpose()
}
pub fn save(app: &tauri::AppHandle, scope: &str, state: &Value) -> Result<(), String> {
    crate::agent_runtime::init(app)?;
    crate::agent_runtime::conn(app)?.execute("INSERT INTO execution_checkpoints(scope,state_json,updated_at) VALUES(?1,?2,unixepoch()) ON CONFLICT(scope) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at", params![scope,state.to_string()]).map_err(|e|e.to_string())?;
    Ok(())
}
/// None grants execution, Some returns a previously committed result.
pub fn begin_tool(app: &tauri::AppHandle, task: &str, op: &str, name: &str, args: &Value) -> Result<Option<(String, bool)>, String> {
    let c = crate::agent_runtime::conn(app)?;
    begin_tool_on(&c,task,op,name,args)
}
fn begin_tool_on(c:&rusqlite::Connection, task:&str, op:&str, name:&str, args:&Value)->Result<Option<(String,bool)>,String> {
    let inserted = c.execute("INSERT OR IGNORE INTO execution_receipts(task_id,operation_id,name,args_json) VALUES(?1,?2,?3,?4)",params![task,op,name,args.to_string()]).map_err(|e|e.to_string())?;
    if inserted == 1 { return Ok(None); }
    let (old_name, old_args, result, ok): (String,String,Option<String>,Option<bool>) = c.query_row("SELECT name,args_json,result,success FROM execution_receipts WHERE task_id=?1 AND operation_id=?2",params![task,op],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|e|e.to_string())?;
    if old_name != name || old_args != args.to_string() { return Err("Identifiant d'opération réutilisé avec d'autres arguments.".into()); }
    match result { Some(r) => Ok(Some((r,ok.unwrap_or(false)))), None => Err(format!("Résultat inconnu pour {name} : exécution interrompue. Vérifier l'état réel avant toute nouvelle action.")) }
}
pub fn end_tool(app: &tauri::AppHandle, task: &str, op: &str, result: &str, success: bool) -> Result<(), String> {
    end_tool_on(&crate::agent_runtime::conn(app)?,task,op,result,success)
}
fn end_tool_on(c:&rusqlite::Connection,task:&str,op:&str,result:&str,success:bool)->Result<(),String> {
    let n = c.execute("UPDATE execution_receipts SET result=?3,success=?4 WHERE task_id=?1 AND operation_id=?2 AND result IS NULL",params![task,op,result,success]).map_err(|e|e.to_string())?;
    if n != 1 { return Err("Résultat d'outil déjà enregistré ou opération absente.".into()); }
    Ok(())
}
pub fn receipts(app: &tauri::AppHandle, task: &str) -> Result<Vec<Value>, String> {
    let c = crate::agent_runtime::conn(app)?;
    let mut q = c.prepare("SELECT operation_id,name,args_json,result,success FROM execution_receipts WHERE task_id=?1 ORDER BY rowid").map_err(|e|e.to_string())?;
    let rows = q.query_map([task],|r| {
        let args: String = r.get(2)?;
        Ok(json!({"operation":r.get::<_,String>(0)?,"tool":r.get::<_,String>(1)?,"args":serde_json::from_str::<Value>(&args).unwrap_or(Value::Null),"result":r.get::<_,Option<String>>(3)?,"success":r.get::<_,Option<bool>>(4)?}))
    }).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

/// Move the split BACK to the assistant call. Never summarize half a batch.
pub fn compaction_split(messages: &[Value], keep: usize) -> usize {
    if messages.len() <= 2 {return messages.len();}
    let mut split = messages.len().saturating_sub(keep.max(1));
    while split > 2 && messages[split].get("role").and_then(Value::as_str) == Some("tool") { split -= 1; }
    split
}
pub fn successful_tools(receipts: &[Value]) -> Vec<String> {
    receipts.iter().filter(|r|r["success"] == true).filter_map(|r|r["tool"].as_str().map(str::to_owned)).collect()
}

/// Keep task/instructions and tool-call pairing intact. Only tool-result text
/// is excerpted for inference; SQLite retains the full receipt for rereading.
pub fn fit_messages(messages: &[Value], tools: &[Value], context: u64) -> Result<Vec<Value>,String> {
    let context=if context==0 {8192} else {context};
    let max_chars=(context as usize * 3 * 3 / 4).saturating_sub(serde_json::to_string(tools).unwrap_or_default().chars().count());
    let size=|m:&[Value]| serde_json::to_string(m).unwrap_or_default().chars().count();
    let mut out=messages.to_vec();
    if size(&out)<=max_chars {return Ok(out);}
    let tool_count=out.iter().filter(|m|m["role"]=="tool").count();
    let fixed=out.iter().filter(|m|m["role"]!="tool").cloned().collect::<Vec<_>>();
    if tool_count==0 || size(&fixed)+tool_count*200>=max_chars {
        return Err("Contexte insuffisant pour conserver l'objectif et les contraintes. Choisis un modèle avec davantage de contexte ou réduis les données jointes.".into());
    }
    let share=(max_chars-size(&fixed))/tool_count;
    for m in &mut out {
        if m["role"]!="tool" {continue;}
        let chars=m["content"].as_str().unwrap_or("").chars().collect::<Vec<_>>();
        let available=share.saturating_sub(200);
        if chars.len()>available {
            let head=available*2/3; let tail=available-head;
            m["content"]=json!(format!("{}\n[… extrait ; résultat intégral conservé dans le reçu de l'opération …]\n{}",chars[..head].iter().collect::<String>(),chars[chars.len()-tail..].iter().collect::<String>()));
        }
    }
    if size(&out)>max_chars {return Err("Le transcript et les schémas dépassent le budget de contexte.".into());}
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn keeps_entire_parallel_batch() {
        let m = vec![json!({"role":"system"}),json!({"role":"user"}),json!({"role":"assistant","tool_calls":[{},{}]}),json!({"role":"tool"}),json!({"role":"tool"}),json!({"role":"assistant"})];
        assert_eq!(compaction_split(&m,3),2);
    }
    #[test] fn failures_are_not_evidence_of_success() {
        assert_eq!(successful_tools(&[json!({"tool":"write","success":false}),json!({"tool":"read","success":true}),json!({"tool":"send","success":null})]), vec!["read"]);
    }
    #[test] fn journal_replays_committed_effect_and_blocks_unknown_effect() {
        let db=rusqlite::Connection::open_in_memory().unwrap(); db.execute_batch(SCHEMA).unwrap();
        assert_eq!(begin_tool_on(&db,"task","batch:0","send",&json!({"to":"a"})).unwrap(),None);
        assert!(begin_tool_on(&db,"task","batch:0","send",&json!({"to":"a"})).unwrap_err().contains("Résultat inconnu"));
        end_tool_on(&db,"task","batch:0","message delivered",true).unwrap();
        assert_eq!(begin_tool_on(&db,"task","batch:0","send",&json!({"to":"a"})).unwrap(),Some(("message delivered".into(),true)));
        assert!(begin_tool_on(&db,"task","batch:0","send",&json!({"to":"b"})).is_err());
        assert!(end_tool_on(&db,"task","batch:0","overwritten",true).is_err());
        assert_eq!(begin_tool_on(&db,"task","batch:1","write",&json!({})).unwrap(),None);
        end_tool_on(&db,"task","batch:1","permission denied",false).unwrap();
        assert_eq!(begin_tool_on(&db,"task","batch:1","write",&json!({})).unwrap(),Some(("permission denied".into(),false)));
    }
    #[test] fn context_budget_preserves_objective_and_tool_pairing() {
        let m=vec![json!({"role":"system","content":"rules"}),json!({"role":"user","content":"Never send the draft. Produce a file."}),json!({"role":"assistant","tool_calls":[{"id":"x"}]}),json!({"role":"tool","tool_call_id":"x","content":format!("[operation x]{}final evidence","z".repeat(30000))})];
        let bounded=fit_messages(&m,&[],2048).unwrap();
        assert_eq!(bounded[1],m[1]); assert_eq!(bounded[2],m[2]);
        assert_eq!(bounded[3]["tool_call_id"],"x");
        assert!(bounded[3]["content"].as_str().unwrap().ends_with("final evidence"));
        assert!(serde_json::to_string(&bounded).unwrap().len()<serde_json::to_string(&m).unwrap().len());
    }
    #[test] fn cannot_silently_drop_oversized_constraints() {
        assert!(fit_messages(&[json!({"role":"user","content":"constraint".repeat(10000)})],&[],2048).is_err());
    }

}
