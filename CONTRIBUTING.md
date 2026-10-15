# Contribuer à Lumen

Les instructions de compilation par plateforme sont dans [BUILDING.md](BUILDING.md).
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
`npm run licenses:collect`. Générer le SBOM avec `npm run security:sbom`.
Les rapports d'audit et le SBOM sont sous
`dist/security/`. Les workflows GitHub contrôlent les plateformes natives ;
ne pas présenter un test macOS comme une validation Windows/Linux.

Décrire le problème, le comportement obtenu et les validations dans la PR.
Privilégier une modification ciblée ; joindre un exemple reproductible pour
un bug et des captures pour une modification visible.

## Données et configuration locale

Effectuer les modifications dans votre clone du dépôt, sur une branche dédiée,
puis ouvrir une pull request. Aucun export de sources n’est nécessaire pour
contribuer.

Ne pas joindre de clés, mots de passe, bases utilisateur, modèles ou caches.
Masquer les données personnelles dans les captures et les journaux joints.
Conserver les identifiants dans des configurations locales exclues de Git.
Vous pouvez définir `CARGO_TARGET_DIR` vers un dossier de build de votre choix.

Pour une vulnérabilité, suivre [SECURITY.md](SECURITY.md) avant de déposer
des détails d'exploitation dans une issue publique.
