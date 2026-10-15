//! Control plane durable des agents.
//!
//! Cette couche ne remplace pas encore le format utilisateur `agents.json` : elle
//! porte l'état transactionnel qui ne peut pas être correctement représenté par
//! un booléen `done` (leases, tentatives, retries, annulation, approbations,
//! plans et traces hiérarchiques). SQLite est déjà embarqué par Lumen pour le RAG.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const LEASE_SECS: u64 = 24 * 60 * 60;
const MAX_ATTEMPTS: u32 = 3;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn id(prefix: &str) -> String {
    format!("{prefix}-{}-{}", now(), NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::shared_data_dir(app.path()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("agent_runtime.db"))
}

pub(crate) fn conn(app: &tauri::AppHandle) -> Result<Connection, String> {
    let c = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    c.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    c.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         PRAGMA synchronous=NORMAL;",
    )
    .map_err(|e| e.to_string())?;
    Ok(c)
}

pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    conn(app)?.execute_batch(crate::execution::SCHEMA).map_err(|e|e.to_string())?;
    conn(app)?
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS tasks(
                task_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                text TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                priority INTEGER NOT NULL DEFAULT 0,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                retry_after INTEGER,
                last_error TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_tasks_agent_status
                ON tasks(agent_id, status, priority DESC, updated_at);
             CREATE TABLE IF NOT EXISTS runs(
                run_id TEXT PRIMARY KEY,
                parent_run_id TEXT,
                agent_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                cancel_requested INTEGER NOT NULL DEFAULT 0,
                result_json TEXT,
                error TEXT NOT NULL DEFAULT ''
             );
             CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id, started_at DESC);
             CREATE TABLE IF NOT EXISTS leases(
                agent_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                expires_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS approvals(
                approval_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                risk TEXT NOT NULL,
                reason TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL,
                decided_at INTEGER
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_call
                ON approvals(run_id, fingerprint);
             CREATE TABLE IF NOT EXISTS trace_events(
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                parent_run_id TEXT,
                task_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                prompt_tokens INTEGER NOT NULL DEFAULT 0,
                gen_tokens INTEGER NOT NULL DEFAULT 0,
                detail_json TEXT NOT NULL DEFAULT '{}'
             );
             CREATE INDEX IF NOT EXISTS idx_trace_run ON trace_events(run_id, seq);
             CREATE TABLE IF NOT EXISTS plans(
                plan_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                status TEXT NOT NULL,
                spec_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS plan_nodes(
                plan_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                agent TEXT NOT NULL,
                task TEXT NOT NULL,
                dependencies_json TEXT NOT NULL,
                acceptance_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                output TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                started_at INTEGER,
                finished_at INTEGER,
                PRIMARY KEY(plan_id, node_id),
                FOREIGN KEY(plan_id) REFERENCES plans(plan_id) ON DELETE CASCADE
             );",
        )
        .map_err(|e| e.to_string())
}

/// À appeler une seule fois au démarrage : aucune exécution de l'ancien process
/// ne peut encore être vivante. Les runs interrompus redeviennent donc
/// immédiatement éligibles au retry, sans attendre l'expiration longue des leases.
pub fn recover_after_restart(app: &tauri::AppHandle) -> Result<(), String> {
    init(app)?;
    let mut c = conn(app)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let ts = now();
    tx.execute("UPDATE runs SET status='interrupted',finished_at=?1,error='Application redémarrée pendant le run' WHERE status='running'",params![ts]).map_err(|e| e.to_string())?;
    tx.execute("UPDATE tasks SET status='retry_scheduled',retry_after=?1,last_error='Run interrompu par un redémarrage',updated_at=?1 WHERE status='running'",params![ts]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM leases",[]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Remet une tâche terminée dans la file d'exécution.
///
/// L'état d'une tâche vit à DEUX endroits : la coche `done` d'`agents.json`, que
/// l'utilisateur manipule, et le statut du runtime (`succeeded`, `blocked`…),
/// qui décide seul de ce qui est exécutable (`task_runnable`). Décocher une
/// tâche terminée ne touchait que le premier : elle redevenait visible dans
/// l'app mais restait `succeeded` pour le runtime, donc jamais reprise. L'agent
/// répondait « Aucune tâche en attente », et le seul contournement était d'en
/// recréer une.
///
/// Seuls les statuts TERMINAUX sont repris, ce qui rend l'appel sûr à répéter :
/// une tâche en cours (`running`), déjà en file (`queued`) ou en attente de
/// réessai (`retry_scheduled`, dont le délai est légitime) n'est pas touchée. Le
/// compteur de tentatives repart de zéro, sans quoi rouvrir une tâche `blocked`
/// après trois échecs ne lui rendrait pas son budget.
pub fn requeue_if_finished(app: &tauri::AppHandle, task_id: &str) {
    if let Ok(c) = conn(app) {
        let _ = c.execute(
            "UPDATE tasks SET status='queued',attempt_count=0,retry_after=NULL,last_error='',updated_at=?2
             WHERE task_id=?1 AND status IN ('succeeded','cancelled','blocked')",
            params![task_id, now()],
        );
    }
}

pub fn task_runnable(app: &tauri::AppHandle, task_id: &str) -> bool {
    let ts = now();
    conn(app).ok().and_then(|c| c.query_row("SELECT status,retry_after FROM tasks WHERE task_id=?1",params![task_id],|r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<u64>>(1)?))).optional().ok().flatten())
        .map(|(status,retry)| status == "queued" || (status == "retry_scheduled" && retry.unwrap_or(0) <= ts))
        .unwrap_or(true)
}

#[derive(Clone, Debug, Serialize)]
pub struct Claim {
    pub run_id: String,
    pub attempt_id: String,
    pub task_id: String,
    pub attempt: u32,
}

/// Réserve atomiquement un agent et une tâche. Une lease interdit les doubles
/// déclenchements CRON/manuels pendant qu'un run est actif.
pub fn claim(
    app: &tauri::AppHandle,
    agent_id: &str,
    task_id: &str,
    text: &str,
    parent_run_id: Option<&str>,
) -> Result<Claim, String> {
    init(app)?;
    let mut c = conn(app)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let ts = now();
    tx.execute("DELETE FROM leases WHERE expires_at <= ?1", params![ts])
        .map_err(|e| e.to_string())?;
    let active: Option<String> = tx
        .query_row(
            "SELECT run_id FROM leases WHERE agent_id=?1",
            params![agent_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(run) = active {
        return Err(format!("Agent déjà en cours d’exécution (run {run})"));
    }
    tx.execute(
        "INSERT INTO tasks(task_id,agent_id,text,status,updated_at)
         VALUES(?1,?2,?3,'queued',?4)
         ON CONFLICT(task_id) DO UPDATE SET agent_id=excluded.agent_id,text=excluded.text,updated_at=excluded.updated_at",
        params![task_id, agent_id, text, ts],
    )
    .map_err(|e| e.to_string())?;
    let (status, attempts, retry_after): (String, u32, Option<u64>) = tx
        .query_row(
            "SELECT status,attempt_count,retry_after FROM tasks WHERE task_id=?1",
            params![task_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    if status == "cancelled" || status == "succeeded" {
        return Err(format!("Tâche non exécutable : état {status}"));
    }
    if let Some(at) = retry_after {
        if at > ts {
            return Err(format!("Nouvelle tentative planifiée dans {} s", at - ts));
        }
    }
    let attempt = attempts + 1;
    let run_id = id("run");
    let attempt_id = id("attempt");
    tx.execute(
        "UPDATE tasks SET status='running',attempt_count=?2,retry_after=NULL,updated_at=?3 WHERE task_id=?1",
        params![task_id, attempt, ts],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO runs(run_id,parent_run_id,agent_id,task_id,attempt_id,status,started_at)
         VALUES(?1,?2,?3,?4,?5,'running',?6)",
        params![run_id, parent_run_id, agent_id, task_id, attempt_id, ts],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO leases(agent_id,run_id,expires_at) VALUES(?1,?2,?3)",
        params![agent_id, run_id, ts + LEASE_SECS],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Claim {
        run_id,
        attempt_id,
        task_id: task_id.to_string(),
        attempt,
    })
}

pub fn finish(
    app: &tauri::AppHandle,
    claim: &Claim,
    success: bool,
    result: &Value,
    error: &str,
) -> Result<String, String> {
    let mut c = conn(app)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let ts = now();
    let cancelled = error.to_lowercase().contains("annul");
    let status = if success {
        "succeeded"
    } else if cancelled {
        "cancelled"
    } else if claim.attempt >= MAX_ATTEMPTS {
        "blocked"
    } else {
        "retry_scheduled"
    };
    let retry_after = if status == "retry_scheduled" {
        Some(ts + 30 * 2u64.pow(claim.attempt.saturating_sub(1)))
    } else {
        None
    };
    tx.execute(
        "UPDATE runs SET status=?2,finished_at=?3,result_json=?4,error=?5 WHERE run_id=?1",
        params![claim.run_id, status, ts, result.to_string(), error],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE tasks SET status=?2,retry_after=?3,last_error=?4,updated_at=?5 WHERE task_id=?1",
        params![claim.task_id, status, retry_after, error, ts],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM leases WHERE agent_id=(SELECT agent_id FROM runs WHERE run_id=?1) AND run_id=?1",
        params![claim.run_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    // Fin de course : on prévient le téléphone. Uniquement pour les issues qui
    // demandent de savoir — un succès et un blocage définitif. Une nouvelle
    // tentative programmée n'est pas un évènement pour un humain.
    if status == "succeeded" || status == "blocked" {
        let agent = c
            .query_row(
                "SELECT agent_id FROM runs WHERE run_id=?1",
                params![claim.run_id],
                |r| r.get::<_, String>(0),
            )
            .unwrap_or_default();
        crate::push::notify_detached(
            app,
            Some(crate::session::active_profile_id(app)),
            if success { "Agent terminé".into() } else { "Agent bloqué".into() },
            if success {
                format!("{agent} a terminé sa tâche.")
            } else {
                format!("{agent} s'est arrêté : {}", crate::native_tools::short(error, 120))
            },
            "/#agents".into(),
        );
    }
    Ok(status.to_string())
}

pub fn release_for_escalation(app: &tauri::AppHandle, claim: &Claim, reason: &str) {
    if let Ok(c) = conn(app) {
        let ts = now();
        let _ = c.execute(
            "UPDATE runs SET status='waiting_approval',error=?2 WHERE run_id=?1",
            params![claim.run_id, reason],
        );
        let _ = c.execute(
            "UPDATE tasks SET status='waiting_approval',last_error=?2,updated_at=?3 WHERE task_id=?1",
            params![claim.task_id, reason, ts],
        );
        let _ = c.execute("DELETE FROM leases WHERE run_id=?1", params![claim.run_id]);
    }
}

pub fn request_cancel(app: &tauri::AppHandle, agent_id: &str) -> Result<bool, String> {
    let c = conn(app)?;
    let changed = c
        .execute(
            "UPDATE runs SET cancel_requested=1 WHERE agent_id=?1 AND status='running'",
            params![agent_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

pub fn cancelled(app: &tauri::AppHandle, run_id: &str) -> bool {
    conn(app)
        .ok()
        .and_then(|c| {
            c.query_row(
                "SELECT cancel_requested FROM runs WHERE run_id=?1",
                params![run_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .ok()
            .flatten()
        })
        .unwrap_or(0)
        != 0
}

pub fn trace(
    app: &tauri::AppHandle,
    claim: &Claim,
    parent_run_id: Option<&str>,
    kind: &str,
    name: &str,
    status: &str,
    prompt_tokens: u64,
    gen_tokens: u64,
    detail: &Value,
) {
    if let Ok(c) = conn(app) {
        let ts = now();
        let finished = matches!(status, "succeeded" | "failed" | "cancelled" | "blocked");
        let _ = c.execute(
            "INSERT INTO trace_events(run_id,parent_run_id,task_id,agent_id,attempt_id,kind,name,status,started_at,finished_at,prompt_tokens,gen_tokens,detail_json)
             VALUES(?1,?2,?3,(SELECT agent_id FROM runs WHERE run_id=?1),?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![claim.run_id,parent_run_id,claim.task_id,claim.attempt_id,kind,name,status,ts,if finished {Some(ts)} else {None},prompt_tokens,gen_tokens,detail.to_string()],
        );
    }
}

pub fn request_approval(
    app: &tauri::AppHandle,
    claim: &Claim,
    fingerprint: &str,
    tool: &str,
    risk: &str,
    reason: &str,
) -> Result<String, String> {
    let c = conn(app)?;
    c.execute(
        "INSERT INTO approvals(approval_id,run_id,agent_id,fingerprint,tool_name,risk,reason,status,created_at)
         VALUES(?1,?2,(SELECT agent_id FROM runs WHERE run_id=?2),?3,?4,?5,?6,'pending',?7)
         ON CONFLICT(run_id,fingerprint) DO NOTHING",
        params![id("approval"), claim.run_id, fingerprint, tool, risk, reason, now()],
    )
    .map_err(|e| e.to_string())?;
    // Id réel (nouveau ou déjà en attente) : la notification iOS s'en sert
    // pour « Approuver / Refuser » sans ouvrir l'app.
    c.query_row(
        "SELECT approval_id FROM approvals WHERE run_id=?1 AND fingerprint=?2",
        params![claim.run_id, fingerprint],
        |r| r.get::<_, String>(0),
    )
    .map_err(|e| e.to_string())
}

pub fn approval_granted(app: &tauri::AppHandle, agent_id: &str, fingerprint: &str) -> bool {
    conn(app)
        .ok()
        .and_then(|c| {
            c.query_row(
                "SELECT 1 FROM approvals WHERE agent_id=?1 AND fingerprint=?2 AND status='approved' ORDER BY created_at DESC LIMIT 1",
                params![agent_id, fingerprint],
                |_| Ok(1i64),
            )
            .optional().ok().flatten()
        })
        .is_some()
}

pub fn decide_pending(app: &tauri::AppHandle, agent_id: &str, approve: bool) {
    if let Ok(c) = conn(app) {
        let _ = c.execute(
            "UPDATE approvals SET status=?2,decided_at=?3 WHERE approval_id=(SELECT approval_id FROM approvals WHERE agent_id=?1 AND status='pending' ORDER BY created_at DESC LIMIT 1)",
            params![agent_id, if approve {"approved"} else {"rejected"}, now()],
        );
    }
}

#[derive(Serialize)]
pub struct RuntimeTask {
    task_id: String,
    agent_id: String,
    text: String,
    status: String,
    attempt_count: u32,
    retry_after: Option<u64>,
    last_error: String,
    updated_at: u64,
}

#[tauri::command]
pub fn agent_runtime_tasks(app: tauri::AppHandle, agent_id: String) -> Result<Vec<RuntimeTask>, String> {
    init(&app)?;
    let c = conn(&app)?;
    let mut q = c.prepare("SELECT task_id,agent_id,text,status,attempt_count,retry_after,last_error,updated_at FROM tasks WHERE agent_id=?1 ORDER BY updated_at DESC").map_err(|e| e.to_string())?;
    let rows = q.query_map(params![agent_id], |r| Ok(RuntimeTask { task_id:r.get(0)?,agent_id:r.get(1)?,text:r.get(2)?,status:r.get(3)?,attempt_count:r.get(4)?,retry_after:r.get(5)?,last_error:r.get(6)?,updated_at:r.get(7)? }))
        .map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string());
    rows
}

/// Vue « activité » compacte, pensée pour un écran de téléphone : ce qui tourne,
/// ce qui vient de finir, et ce qui ATTEND une décision. C'est la dernière qui
/// justifie l'écran : un agent bloqué sur une demande d'approbation attend
/// aujourd'hui que l'on rentre devant le Mac.
pub fn activity(app: &tauri::AppHandle, limit: usize) -> Result<Value, String> {
    init(app)?;
    let c = conn(app)?;
    let limit = limit.clamp(1, 50) as i64;

    let mut q = c
        .prepare(
            "SELECT run_id, agent_id, status, started_at, finished_at, error
             FROM runs ORDER BY started_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let runs: Vec<Value> = q
        .query_map(params![limit], |r| {
            Ok(serde_json::json!({
                "run_id": r.get::<_, String>(0)?,
                "agent_id": r.get::<_, String>(1)?,
                "status": r.get::<_, String>(2)?,
                "started_at": r.get::<_, i64>(3)?,
                "finished_at": r.get::<_, Option<i64>>(4)?,
                "error": r.get::<_, String>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut q = c
        .prepare(
            "SELECT approval_id, run_id, agent_id, tool_name, risk, reason, created_at
             FROM approvals WHERE status='pending' ORDER BY created_at DESC LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let approvals: Vec<Value> = q
        .query_map([], |r| {
            Ok(serde_json::json!({
                "approval_id": r.get::<_, String>(0)?,
                "run_id": r.get::<_, String>(1)?,
                "agent_id": r.get::<_, String>(2)?,
                "tool": r.get::<_, String>(3)?,
                "risk": r.get::<_, String>(4)?,
                "reason": r.get::<_, String>(5)?,
                "created_at": r.get::<_, i64>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut q = c
        .prepare(
            "SELECT task_id, agent_id, text, status, last_error, updated_at
             FROM tasks WHERE status IN ('queued','running','retry') ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let tasks: Vec<Value> = q
        .query_map(params![limit], |r| {
            Ok(serde_json::json!({
                "task_id": r.get::<_, String>(0)?,
                "agent_id": r.get::<_, String>(1)?,
                "text": r.get::<_, String>(2)?,
                "status": r.get::<_, String>(3)?,
                "error": r.get::<_, String>(4)?,
                "updated_at": r.get::<_, i64>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    Ok(serde_json::json!({ "runs": runs, "approvals": approvals, "tasks": tasks }))
}

/// Tranche une décision d'approbation PAR SON IDENTIFIANT. `decide_pending`
/// vise « la plus récente de l'agent », ce qui suffit à un dialogue modal
/// devant l'écran, mais pas à une liste sur un téléphone : entre l'affichage et
/// le geste, une autre demande a pu arriver.
pub fn decide_approval(app: &tauri::AppHandle, approval_id: &str, approve: bool) -> Result<bool, String> {
    let c = conn(app)?;
    let n = c
        .execute(
            "UPDATE approvals SET status=?2, decided_at=?3 WHERE approval_id=?1 AND status='pending'",
            params![approval_id, if approve { "approved" } else { "rejected" }, now()],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// `agent_activity` existe déjà pour le journal d'UN agent (cf. `agents.rs`) :
/// celle-ci est la vue transversale du runtime, d'où le nom distinct.
#[tauri::command]
pub fn agent_runtime_activity(app: tauri::AppHandle, limit: Option<usize>) -> Result<Value, String> {
    activity(&app, limit.unwrap_or(20))
}

#[tauri::command]
pub fn agent_cancel_run(app: tauri::AppHandle, agent_id: String) -> Result<bool, String> {
    request_cancel(&app, &agent_id)
}

#[tauri::command]
pub fn agent_trace(app: tauri::AppHandle, run_id: String) -> Result<Vec<Value>, String> {
    init(&app)?;
    let c = conn(&app)?;
    let mut q = c.prepare("SELECT seq,run_id,parent_run_id,task_id,agent_id,attempt_id,kind,name,status,started_at,finished_at,prompt_tokens,gen_tokens,detail_json FROM trace_events WHERE run_id=?1 ORDER BY seq").map_err(|e| e.to_string())?;
    let rows = q.query_map(params![run_id], |r| {
        let detail: String = r.get(13)?;
        Ok(serde_json::json!({"seq":r.get::<_,u64>(0)?,"run_id":r.get::<_,String>(1)?,"parent_run_id":r.get::<_,Option<String>>(2)?,"task_id":r.get::<_,String>(3)?,"agent_id":r.get::<_,String>(4)?,"attempt_id":r.get::<_,String>(5)?,"kind":r.get::<_,String>(6)?,"name":r.get::<_,String>(7)?,"status":r.get::<_,String>(8)?,"started_at":r.get::<_,u64>(9)?,"finished_at":r.get::<_,Option<u64>>(10)?,"prompt_tokens":r.get::<_,u64>(11)?,"gen_tokens":r.get::<_,u64>(12)?,"detail":serde_json::from_str::<Value>(&detail).unwrap_or(Value::Null)}))
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string());
    rows
}

#[derive(Clone, Deserialize)]
pub struct PlanNodeSpec {
    pub id: String,
    pub agent: String,
    pub task: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub acceptance: Vec<String>,
}

#[derive(Clone, Deserialize)]
pub struct PlanSpec {
    pub nodes: Vec<PlanNodeSpec>,
    #[serde(default = "default_parallel")]
    pub max_parallel: usize,
}

fn default_parallel() -> usize { 3 }

pub fn validate_plan(spec: &PlanSpec) -> Result<(), String> {
    if spec.nodes.is_empty() || spec.nodes.len() > 32 { return Err("Le plan doit contenir entre 1 et 32 nœuds".into()); }
    let ids: std::collections::HashSet<&str> = spec.nodes.iter().map(|n| n.id.as_str()).collect();
    if ids.len() != spec.nodes.len() || ids.contains("") { return Err("Chaque nœud doit avoir un id unique non vide".into()); }
    for n in &spec.nodes {
        if n.task.trim().is_empty() || n.agent.trim().is_empty() { return Err(format!("Nœud {} incomplet", n.id)); }
        if n.depends_on.iter().any(|d| !ids.contains(d.as_str()) || d == &n.id) { return Err(format!("Dépendance invalide dans {}", n.id)); }
    }
    // Kahn : détecte les cycles avant toute action.
    let mut done = std::collections::HashSet::new();
    while done.len() < spec.nodes.len() {
        let before = done.len();
        for n in &spec.nodes { if !done.contains(&n.id) && n.depends_on.iter().all(|d| done.contains(d)) { done.insert(n.id.clone()); } }
        if done.len() == before { return Err("Le plan contient un cycle".into()); }
    }
    Ok(())
}

pub fn create_plan(app: &tauri::AppHandle, claim: &Claim, spec: &PlanSpec) -> Result<String, String> {
    validate_plan(spec)?;
    let mut c = conn(app)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let plan_id = id("plan");
    let ts = now();
    let raw = serde_json::to_string(&serde_json::json!({"max_parallel":spec.max_parallel,"nodes":spec.nodes.iter().map(|n| serde_json::json!({"id":n.id,"agent":n.agent,"task":n.task,"depends_on":n.depends_on,"acceptance":n.acceptance})).collect::<Vec<_>>() })).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO plans(plan_id,run_id,status,spec_json,created_at,updated_at) VALUES(?1,?2,'running',?3,?4,?4)",params![plan_id,claim.run_id,raw,ts]).map_err(|e| e.to_string())?;
    for n in &spec.nodes {
        tx.execute("INSERT INTO plan_nodes(plan_id,node_id,agent,task,dependencies_json,acceptance_json,status) VALUES(?1,?2,?3,?4,?5,?6,'queued')",params![plan_id,n.id,n.agent,n.task,serde_json::to_string(&n.depends_on).unwrap_or_default(),serde_json::to_string(&n.acceptance).unwrap_or_default()]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(plan_id)
}

pub fn update_plan_node(app: &tauri::AppHandle, plan_id: &str, node_id: &str, status: &str, output: &str, error: &str) {
    if let Ok(c)=conn(app) { let ts=now(); let _=c.execute("UPDATE plan_nodes SET status=?3,output=?4,error=?5,started_at=COALESCE(started_at,?6),finished_at=CASE WHEN ?3 IN ('succeeded','failed','blocked') THEN ?6 ELSE finished_at END WHERE plan_id=?1 AND node_id=?2",params![plan_id,node_id,status,output,error,ts]); let _=c.execute("UPDATE plans SET updated_at=?2 WHERE plan_id=?1",params![plan_id,ts]); }
}

pub fn finish_plan(app: &tauri::AppHandle, plan_id: &str, success: bool) {
    if let Ok(c)=conn(app) { let _=c.execute("UPDATE plans SET status=?2,updated_at=?3 WHERE plan_id=?1",params![plan_id,if success {"succeeded"} else {"failed"},now()]); }
}

#[tauri::command]
pub fn agent_plan_get(app: tauri::AppHandle, plan_id: String) -> Result<Value, String> {
    init(&app)?;
    let c = conn(&app)?;
    let plan: (String, String, String, u64, u64) = c.query_row(
        "SELECT run_id,status,spec_json,created_at,updated_at FROM plans WHERE plan_id=?1",
        params![plan_id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
    ).map_err(|_| "Plan introuvable".to_string())?;
    let mut q = c.prepare("SELECT node_id,agent,task,dependencies_json,acceptance_json,status,output,error,started_at,finished_at FROM plan_nodes WHERE plan_id=?1 ORDER BY rowid").map_err(|e| e.to_string())?;
    let nodes = q.query_map(params![plan_id], |r| {
        let deps:String=r.get(3)?; let acceptance:String=r.get(4)?;
        Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"agent":r.get::<_,String>(1)?,"task":r.get::<_,String>(2)?,"depends_on":serde_json::from_str::<Value>(&deps).unwrap_or(Value::Array(vec![])),"acceptance":serde_json::from_str::<Value>(&acceptance).unwrap_or(Value::Array(vec![])),"status":r.get::<_,String>(5)?,"output":r.get::<_,String>(6)?,"error":r.get::<_,String>(7)?,"started_at":r.get::<_,Option<u64>>(8)?,"finished_at":r.get::<_,Option<u64>>(9)?}))
    }).map_err(|e| e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"plan_id":plan_id,"run_id":plan.0,"status":plan.1,"spec":serde_json::from_str::<Value>(&plan.2).unwrap_or(Value::Null),"created_at":plan.3,"updated_at":plan.4,"nodes":nodes}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plan_rejects_cycles() {
        let p=PlanSpec{max_parallel:2,nodes:vec![PlanNodeSpec{id:"a".into(),agent:"A".into(),task:"x".into(),depends_on:vec!["b".into()],acceptance:vec![]},PlanNodeSpec{id:"b".into(),agent:"B".into(),task:"y".into(),depends_on:vec!["a".into()],acceptance:vec![]}]};
        assert!(validate_plan(&p).is_err());
    }
}
