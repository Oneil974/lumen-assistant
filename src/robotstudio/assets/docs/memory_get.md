# memory_get

Récupère une valeur depuis la mémoire locale du robot.

## Description
Lit une valeur stockée avec `memory_set` dans la base SQLite locale.

## Entrées
- **SERVER** : input_value – chemin du fichier SQLite.
- **NAMESPACE** : input_value – nom d'espace.
- **KEY** : input_value – clé à lire.

## Sortie
- La valeur stockée (ou `None` si absente).
