# Runtime agentique durable

Lumen conserve la définition éditable des agents dans `agents.json`, mais porte
désormais l'état d'exécution transactionnel dans `agent_runtime.db` (SQLite WAL).

## États

Une tâche traverse les états `queued`, `running`, `waiting_approval`,
`retry_scheduled`, `succeeded`, `blocked` ou `cancelled`. Un échec ne met plus le
booléen historique `done` à vrai. Trois tentatives sont autorisées, avec backoff.

Une lease par agent empêche les doubles lancements CRON/manuels/délégués. Au
redémarrage de Lumen, les runs interrompus sont libérés et remis en retry.

## Protocole de fin

Les agents doivent terminer par un objet JSON :

```json
{
  "success": true,
  "report": "résultat concis",
  "evidence": ["preuve observable"],
  "artifacts": ["sandbox://…"],
  "retryable": false
}
```

Si une tâche possède des `acceptance_criteria`, un appel indépendant vérifie les
preuves. La tâche n'est close que si ce contrôle l'accepte.

## Orchestration

Un agent orchestrateur dispose de `execute_plan`. Le plan est un DAG de 32 nœuds
maximum, persistant dans SQLite. Les nœuds prêts sont exécutés en parallèle
(limite 1–6), les dépendances échouées bloquent leurs descendants et chaque
sous-run porte un lien parent.

## Effets et approbations

Les outils sont classés `read`, `write`, `external` ou `destructive`, avec un
niveau de risque, une indication d'idempotence et un timeout contractuel. La
politique équilibrée exige une approbation pour `external`, `destructive` et
`high`. L'approbation reprend le transcript persisté avant l'effet.

## Traces et commandes

- `agent_runtime_tasks(agentId)` : états et tentatives des tâches.
- `agent_cancel_run(agentId)` : annulation coopérative.
- `agent_trace(runId)` : trace ordonnée et rejouable d'un run.
- `agent_plan_get(planId)` : état et sorties d'un DAG.
- `agent_eval_suite()` : smoke-tests déterministes sans consommation de tokens.
- `skill_validate(name)` : validation statique d'un skill actif.

Les créations/améliorations de skills passent par un candidat, un canary statique
et une promotion atomique. Trois échecs consécutifs d'une version entraînent un
rollback automatique vers la version précédente.

Le smart routing des modèles, agents et skills reste volontairement hors de ce
lot.
