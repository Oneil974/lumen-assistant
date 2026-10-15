# Audits et validation

## Dépendances et licences

Le code original et la documentation sont sous GPL-3.0-or-later.
Les inventaires npm et Cargo et les textes de licence disponibles figurent dans
`src/legal/`. Les licences non déclarées et les textes absents y sont signalés ;
consultez les [notices tierces](../THIRD_PARTY_NOTICES.md) avant redistribution.

Un correctif local de `object` permet à espflash d’utiliser `ruzstd` 0.9.1.
Sa provenance et ses modifications figurent dans
[`LUMEN-PATCH.md`](../src-tauri/crates/object/LUMEN-PATCH.md).

## Contrôles reproductibles

Le [guide de build](../BUILDING.md#développer-et-vérifier) décrit les commandes
de tests, de construction, d’audit et de collecte des licences. Les résultats
GitHub Actions sont disponibles dans l’[onglet Actions](https://github.com/Oneil974/lumen-assistant/actions).
Un résultat local ne garantit pas le succès sur toutes les plateformes.

L’audit npm signale deux alertes modérées dans la chaîne ExcelJS/uuid au
15 octobre 2026. Le contrôle reste en échec tant que ces alertes persistent ;
elles ne sont pas masquées. Les détails des dépendances et des risques suivis
figurent dans la configuration et les rapports des outils d’audit.

## Limites des tests

Le banc d’orchestration scripté ne mesure pas la qualité des modèles réels.
Les tests automatisés ne valident pas à eux seuls les appareils, les connexions
SQL Server réelles, la signature, l’updater ou les installateurs de chaque
plateforme. Les modèles et archives natives optionnelles doivent être vérifiés
séparément pour chaque version distribuée.

Signalez les vulnérabilités en privé selon [SECURITY.md](../SECURITY.md).
