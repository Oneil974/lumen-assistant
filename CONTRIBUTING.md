# Contribuer à Lumen

Les instructions de compilation par plateforme sont dans [README.md](README.md).
Utiliser Node.js 22.12+, Rust stable >= 1.89 et `npm ci`. Les sources originales
sont sous GPL-3.0-or-later ; garder les licences des composants tiers et
documenter l'origine de toute nouvelle dépendance ou ressource graphique.

## Repères

- `src/main.js` : barre et assistant ; `src/sandbox/` : Bureau et Application.
- `src/lib/` : runtime IA, outils, interop et composants partagés.
- `src-tauri/src/` : commandes natives, permissions, stockage et intégrations.
- `scripts/app-packages.mjs` : manifeste du catalogue ;
  [architecture des applications](docs/ARCHITECTURE-APPS.md).
- `src/docs/docs.html` : documentation utilisateur intégrée. Mettre à jour
  cette documentation et le README quand les capacités ou le build changent.

## Vérification d'une modification

Exécuter les tests pertinents puis `npm test`, `npm run eval:orch`,
`npm run build:frontend` et `npm run apps:package`. Pour le backend :
`cargo test --manifest-path src-tauri/Cargo.toml --lib --locked`.
Les tests HTTP locaux ont besoin d'ouvrir un port loopback.

Une modification des dépendances exige `npm run security:audit` et
`npm run licenses:collect`. Les rapports d'audit et le SBOM sont sous
`dist/security/`. Les workflows GitHub contrôlent les plateformes natives ;
ne pas présenter un test macOS comme une validation Windows/Linux.

Décrire le problème, le comportement obtenu et les validations dans la PR.
Privilégier une modification ciblée ; joindre un exemple reproductible pour
un bug et des captures pour une modification visible.

## Données et configuration locale

Ne pas joindre clés, bases utilisateur, modèles ou caches. Un contributeur
peut définir `CARGO_TARGET_DIR` vers son propre volume ; la configuration
du mainteneur est exclue de l'export public. Le dossier `public-source/`
est un miroir géré : effectuer les changements dans le dossier source puis
relancer `npm run source:sync`.

Pour une vulnérabilité, suivre [SECURITY.md](SECURITY.md) avant de déposer
des détails d'exploitation dans une issue publique.
