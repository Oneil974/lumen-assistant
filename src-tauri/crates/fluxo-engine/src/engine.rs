//! Le registre d'actions et l'interpréteur de workflow.
//!
//! Le workflow est une liste plate de pas. Les pas « ordinaires » sont des
//! [`Action`] exécutées via le registre ; les pas de contrôle (`if`, `repeat`,
//! …, cf. [`crate::control`]) sont interprétés ici avec une table de sauts et
//! une pile de boucles.

use crate::action::{Action, ActionSpec, ExecContext};
use crate::control;
use crate::value::Value;
use crate::workflow::{RunResult, Step, StepLog, Workflow};
use std::collections::BTreeMap;
use std::sync::Arc;

/// Résout un workflow par son nom (pour le bloc « Exécuter un workflow »).
/// Fourni par l'hôte (app/Lumen) car le moteur ignore où sont stockés les
/// workflows.
pub type WorkflowResolver = Arc<dyn Fn(&str) -> Option<Workflow> + Send + Sync>;

/// Profondeur max d'imbrication de sous-workflows (garde-fou anti-récursion).
const MAX_SUBWORKFLOW_DEPTH: usize = 8;

pub struct Engine {
    actions: BTreeMap<String, Arc<dyn Action>>,
    resolver: Option<WorkflowResolver>,
}

/// Cadre de boucle empilé pendant l'exécution.
enum LoopFrame {
    Count { remaining: i64, start: usize, index: i64 },
    Each { items: Vec<Value>, idx: usize, start: usize },
}

impl Engine {
    pub fn empty() -> Self {
        Self {
            actions: BTreeMap::new(),
            resolver: None,
        }
    }

    /// Définit le résolveur de sous-workflows (utilisé par le bloc `run_workflow`).
    pub fn set_resolver<F>(&mut self, f: F)
    where
        F: Fn(&str) -> Option<Workflow> + Send + Sync + 'static,
    {
        self.resolver = Some(Arc::new(f));
    }

    pub fn with_builtins() -> Self {
        let mut e = Self::empty();
        crate::actions::register_builtins(&mut e);
        e
    }

    pub fn register(&mut self, action: Arc<dyn Action>) {
        self.actions.insert(action.spec().id.clone(), action);
    }

    /// Schémas de toutes les actions + des blocs de contrôle → bibliothèque UI.
    pub fn specs(&self) -> Vec<ActionSpec> {
        let mut specs: Vec<ActionSpec> = self.actions.values().map(|a| a.spec()).collect();
        specs.extend(control::control_specs());
        specs.push(control::subworkflow_spec());
        specs
    }

    /// Exécute un workflow sans entrée initiale.
    pub fn run(&self, wf: &Workflow) -> RunResult {
        self.run_with_input(wf, Value::Null)
    }

    /// Exécute un workflow en fournissant une valeur d'entrée initiale,
    /// accessible dès la première étape via `{{input}}`. Utilisé quand Fluxo est
    /// piloté par un autre programme (ex. Lumen lui transmet le texte du chat).
    pub fn run_with_input(&self, wf: &Workflow, input: Value) -> RunResult {
        self.run_inner(wf, input, &BTreeMap::new(), 0, &None)
    }

    /// Comme [`run_with_vars`], en fixant en plus une **racine de sandbox** : les
    /// actions fichiers avec l'option « confiner à la sandbox » y sont cantonnées.
    /// Utilisé par l'hôte (Lumen) pour exécuter les skills d'un agent dans sa sandbox.
    pub fn run_with_vars_in_sandbox(
        &self,
        wf: &Workflow,
        input: Value,
        vars: BTreeMap<String, Value>,
        sandbox_root: Option<std::path::PathBuf>,
    ) -> RunResult {
        self.run_inner(wf, input, &vars, 0, &sandbox_root)
    }

    /// Comme [`run_with_input`], mais en pré-amorçant des variables nommées,
    /// accessibles dès la première étape via `{{nom}}`. L'hôte (Lumen) s'en sert
    /// pour injecter le contexte du run — typiquement `run_id` — sans passer par
    /// l'environnement (donc sans course entre runs concurrents). Les variables
    /// sont aussi propagées aux sous-workflows.
    pub fn run_with_vars(
        &self,
        wf: &Workflow,
        input: Value,
        vars: BTreeMap<String, Value>,
    ) -> RunResult {
        self.run_inner(wf, input, &vars, 0, &None)
    }

    fn run_inner(
        &self,
        wf: &Workflow,
        input: Value,
        seed: &BTreeMap<String, Value>,
        depth: usize,
        sandbox_root: &Option<std::path::PathBuf>,
    ) -> RunResult {
        let steps = &wf.steps;
        let jumps = build_jump_table(steps);
        let mut ctx = ExecContext::new();
        ctx.initial = input.clone();
        ctx.input = input;
        ctx.sandbox_root = sandbox_root.clone();
        // Variables pré-amorcées par l'hôte (ex. run_id), visibles en {{…}}.
        for (k, v) in seed {
            ctx.vars.insert(k.clone(), v.clone());
        }
        let mut log = Vec::new();
        let mut loops: Vec<LoopFrame> = Vec::new();
        let mut last_output = Value::Null;
        let mut success = true;

        let mut pc = 0usize;
        let mut guard = 0u64;
        const MAX: u64 = 1_000_000;

        while pc < steps.len() {
            guard += 1;
            if guard > MAX {
                log.push(err_log(&steps[pc], "Trop d'itérations (boucle infinie ?)"));
                success = false;
                break;
            }
            let step = &steps[pc];
            let id = step.action.as_str();

            // -------- Pas de contrôle --------
            if control::is_control(id) {
                match id {
                    control::IF => {
                        let params = resolve_params(&step.params, &ctx);
                        let taken = control::eval_condition(&params);
                        log.push(ok_log(step, Value::Bool(taken)));
                        if taken {
                            pc += 1;
                        } else {
                            pc = jumps[pc] + 1; // saute vers le corps du Sinon ou après Fin Si
                        }
                    }
                    control::ELSE => {
                        // Atteint après le corps du Si : on saute le corps du Sinon.
                        pc = jumps[pc] + 1;
                    }
                    control::ENDIF => pc += 1,
                    control::REPEAT => {
                        let params = resolve_params(&step.params, &ctx);
                        let count = params
                            .get("count")
                            .and_then(|v| v.as_number())
                            .unwrap_or(0.0) as i64;
                        log.push(ok_log(step, Value::Number(count as f64)));
                        if count <= 0 {
                            pc = jumps[pc] + 1;
                        } else {
                            ctx.vars.insert("index".into(), Value::Number(1.0));
                            loops.push(LoopFrame::Count {
                                remaining: count - 1,
                                start: pc,
                                index: 1,
                            });
                            pc += 1;
                        }
                    }
                    control::ENDREPEAT => {
                        if let Some(LoopFrame::Count {
                            remaining,
                            start,
                            index,
                        }) = loops.last_mut()
                        {
                            if *remaining > 0 {
                                *remaining -= 1;
                                *index += 1;
                                ctx.vars.insert("index".into(), Value::Number(*index as f64));
                                pc = *start + 1;
                            } else {
                                loops.pop();
                                pc += 1;
                            }
                        } else {
                            pc += 1;
                        }
                    }
                    control::REPEAT_EACH => {
                        let params = resolve_params(&step.params, &ctx);
                        let items = params
                            .get("list")
                            .map(|v| v.as_list())
                            .unwrap_or_default();
                        log.push(ok_log(step, Value::Number(items.len() as f64)));
                        if items.is_empty() {
                            pc = jumps[pc] + 1;
                        } else {
                            let first = items[0].clone();
                            ctx.vars.insert("item".into(), first.clone());
                            ctx.vars.insert("index".into(), Value::Number(1.0));
                            ctx.input = first;
                            loops.push(LoopFrame::Each {
                                items,
                                idx: 0,
                                start: pc,
                            });
                            pc += 1;
                        }
                    }
                    control::ENDREPEAT_EACH => {
                        if let Some(LoopFrame::Each { items, idx, start }) = loops.last_mut() {
                            *idx += 1;
                            if *idx < items.len() {
                                let it = items[*idx].clone();
                                ctx.vars.insert("item".into(), it.clone());
                                ctx.vars
                                    .insert("index".into(), Value::Number((*idx + 1) as f64));
                                ctx.input = it;
                                pc = *start + 1;
                            } else {
                                loops.pop();
                                pc += 1;
                            }
                        } else {
                            pc += 1;
                        }
                    }
                    control::STOP => {
                        log.push(ok_log(step, Value::Null));
                        break;
                    }
                    _ => pc += 1,
                }
                continue;
            }

            // -------- Sous-workflow (bloc « Exécuter un workflow ») --------
            if id == "run_workflow" {
                let params = resolve_params(&step.params, &ctx);
                let target = params
                    .get("workflow")
                    .map(|v| v.as_text())
                    .unwrap_or_default();
                if depth >= MAX_SUBWORKFLOW_DEPTH {
                    log.push(err_log(step, "Profondeur de sous-workflows trop élevée"));
                    success = false;
                    break;
                }
                let sub = self.resolver.as_ref().and_then(|r| r(&target));
                match sub {
                    Some(subwf) => {
                        let sub_res = self.run_inner(&subwf, ctx.input.clone(), seed, depth + 1, sandbox_root);
                        if sub_res.success {
                            ctx.vars.insert(step.id.clone(), sub_res.output.clone());
                            ctx.input = sub_res.output.clone();
                            last_output = sub_res.output.clone();
                            log.push(ok_log(step, sub_res.output));
                            pc += 1;
                        } else {
                            let msg = sub_res
                                .steps
                                .iter()
                                .rev()
                                .find_map(|s| s.error.clone())
                                .unwrap_or_else(|| "échec".into());
                            log.push(err_log(step, &format!("Sous-workflow « {target} » : {msg}")));
                            success = false;
                            break;
                        }
                    }
                    None => {
                        log.push(err_log(
                            step,
                            &format!("Workflow « {target} » introuvable (ou résolveur absent)"),
                        ));
                        success = false;
                        break;
                    }
                }
                continue;
            }

            // -------- Action ordinaire --------
            let action = match self.actions.get(id) {
                Some(a) => a,
                None => {
                    log.push(err_log(step, &format!("Action inconnue : {id}")));
                    success = false;
                    break;
                }
            };
            let params = resolve_params(&step.params, &ctx);
            match action.run(&params, &mut ctx) {
                Ok(out) => {
                    ctx.vars.insert(step.id.clone(), out.clone());
                    ctx.input = out.clone();
                    last_output = out.clone();
                    log.push(ok_log(step, out));
                    pc += 1;
                }
                Err(e) => {
                    log.push(err_log(step, &e.to_string()));
                    success = false;
                    break;
                }
            }
        }

        RunResult {
            success,
            steps: log,
            output: last_output,
        }
    }
}

fn ok_log(step: &Step, output: Value) -> StepLog {
    StepLog {
        step: step.id.clone(),
        action: step.action.clone(),
        output,
        error: None,
    }
}

fn err_log(step: &Step, msg: &str) -> StepLog {
    StepLog {
        step: step.id.clone(),
        action: step.action.clone(),
        output: Value::Null,
        error: Some(msg.to_string()),
    }
}

/// Pré-calcule, pour chaque ouvreur de bloc, l'index de saut :
/// - `if`   → index du `else` correspondant (ou du `endif` s'il n'y a pas de `else`)
/// - `else` → index du `endif` correspondant
/// - `repeat` / `repeat_each` → index du marqueur de fin (pour sauter si vide)
fn build_jump_table(steps: &[Step]) -> Vec<usize> {
    let mut jumps = vec![0usize; steps.len()];
    let mut stack: Vec<usize> = Vec::new();

    for (i, step) in steps.iter().enumerate() {
        match step.action.as_str() {
            control::IF | control::REPEAT | control::REPEAT_EACH => stack.push(i),
            control::ELSE => {
                if let Some(&if_idx) = stack.last() {
                    jumps[if_idx] = i; // if → else
                }
                stack.push(i); // pour que endif relie le else
            }
            control::ENDIF => {
                if let Some(top) = stack.pop() {
                    if steps[top].action == control::ELSE {
                        jumps[top] = i; // else → endif
                        let _ = stack.pop(); // retire le if (déjà relié au else)
                    } else {
                        jumps[top] = i; // if (sans else) → endif
                    }
                }
            }
            control::ENDREPEAT | control::ENDREPEAT_EACH => {
                if let Some(top) = stack.pop() {
                    jumps[top] = i;
                }
            }
            _ => {}
        }
    }
    jumps
}

fn resolve_params(
    params: &BTreeMap<String, Value>,
    ctx: &ExecContext,
) -> BTreeMap<String, Value> {
    params
        .iter()
        .map(|(k, v)| (k.clone(), resolve_value(v, ctx)))
        .collect()
}

fn resolve_value(v: &Value, ctx: &ExecContext) -> Value {
    match v {
        Value::Text(s) if s.contains("{{") => Value::Text(interpolate(s, ctx)),
        Value::List(items) => Value::List(items.iter().map(|i| resolve_value(i, ctx)).collect()),
        other => other.clone(),
    }
}

fn interpolate(s: &str, ctx: &ExecContext) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(end) = after.find("}}") {
            let name = after[..end].trim();
            // `input` = entrée initiale du workflow ; `last`/`previous` = sortie
            // du bloc immédiatement précédent (ctx.input est réécrit à chaque
            // étape). Tout autre nom = sortie d'un bloc nommé par son id.
            // Un chemin pointé descend dans les Dict/List : `{{bloc.label}}`,
            // `{{bloc.probs.joie}}`, `{{bloc.items.0}}`.
            let (base, path) = match name.split_once('.') {
                Some((b, p)) => (b.trim(), Some(p)),
                None => (name, None),
            };
            let root = if base == "input" {
                Some(&ctx.initial)
            } else if base == "last" || base == "previous" {
                Some(&ctx.input)
            } else {
                ctx.vars.get(base)
            };
            let value = match (root, path) {
                (None, _) => String::new(),
                (Some(v), None) => v.as_text(),
                (Some(v), Some(path)) => {
                    let mut cur = v;
                    let mut found = true;
                    for part in path.split('.').map(str::trim) {
                        cur = match cur {
                            Value::Dict(m) => match m.get(part) {
                                Some(n) => n,
                                None => { found = false; break; }
                            },
                            Value::List(l) => match part.parse::<usize>().ok().and_then(|i| l.get(i)) {
                                Some(n) => n,
                                None => { found = false; break; }
                            },
                            _ => { found = false; break; }
                        };
                    }
                    if found { cur.as_text() } else { String::new() }
                }
            };
            out.push_str(&value);
            rest = &after[end + 2..];
        } else {
            out.push_str("{{");
            rest = after;
        }
    }
    out.push_str(rest);
    out
}
