# memory_set

Enregistre une valeur dans la mémoire locale du robot.

## Description
Stocke une donnée dans une base SQLite locale. Utile pour conserver des paramètres ou des états entre deux exécutions.

## Entrées
- **SERVER** : input_value – chemin du fichier SQLite (ex: `robot_memory.db`).
- **NAMESPACE** : input_value – nom d'espace pour grouper les clés.
- **KEY** : input_value – clé unique.
- **VALUE** : input_value – valeur à enregistrer.

## Sortie
- Aucune
