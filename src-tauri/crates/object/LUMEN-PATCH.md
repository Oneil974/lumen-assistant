# object 0.39.1 — adaptation Lumen

Source : https://crates.io/crates/object/0.39.1 (archive Cargo officielle).
Licences d’origine : MIT OU Apache-2.0 ; textes conservés.

Seul changement fonctionnel : dépendance optionnelle `ruzstd` passée de
0.8.1 à 0.9.1 pour corriger RUSTSEC-2026-0344. Le code de lecture reste
celui de 0.39.1, utilisé par espflash 4.4 ; sa compatibilité est vérifiée
par compilation. Les tests et le lockfile de développement amont sont omis.

Retirer ce patch dès qu’espflash accepte une version officielle de object
qui utilise ruzstd >= 0.9.1. Aucune alerte RustSec n’est ignorée.
