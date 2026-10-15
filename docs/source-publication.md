# Préparer le code source public

## Deux dossiers

Le dossier de développement est la source de vérité. Sa configuration
`src-tauri/.cargo/config.toml`, `dev.sh`, les cibles Sync Hub et le volume
de build APFS restent en place. Le miroir `public-source/` contient une
sélection portable, régénérée par `scripts/export-source.py`.

```bash
npm run source:plan
npm run source:sync
```

Sync Hub propose ces deux opérations dans **Code source**. Pour changer
la destination, définir `public_source_dir` dans sa configuration locale,
ou passer `--out` au script. Un dossier extérieur au workspace peut exiger
une autorisation du système ou de l'outil qui lance la commande.

## Sélection

La liste autorisée est dans `ROOTS` du script. Elle comprend les interfaces,
backend, firmwares, compagnons, serveur autonome, documentation et outils.
Le répertoire d'entraînement, les dossiers de création graphique à la racine,
captures et backups ne sont pas exportés. La sélection n'utilise pas `git`,
donc fonctionne avant la création du premier dépôt public.

Les moteurs précompilés, modèles, bases, secrets par nom/extension, fichiers
AppleDouble et caches sont filtrés. `dev.sh` est remplacé dans le miroir par
un lancement portable ; les cibles Sync Hub sont remplacées par l'exemple.
Toutes les configurations Cargo locales (`.cargo/config.toml`), y compris celle de Sync Hub, sont omises sans être modifiées sur le poste. Les fichiers `config_local.py`, l’enregistrement de test du microphone (`mic_input.wav`) et les captures vidéo brutes MOV sous `docs/assets/` sont également exclus. Le script Bonsai exporté ne conserve pas la recherche du cache dans l’ancien identifiant personnel de l’application. Les crédits d’auteur et les licences restent présents.

Les images Gaming/Cosy et MetroCity sont omises faute de preuve locale
d'autorisation de redistribution des fichiers source. Un manifeste de décors
vide permet au chargeur de fonctionner ; les avatars Kenney restent disponibles.
Les profils choisissant MetroCity peuvent perdre cet affichage dans le miroir
et doivent choisir un avatar disponible. Ne pas promettre une parité graphique
avant remplacement par des ressources autorisées.

## Synchronisations suivantes

Le marqueur `.lumen-source-export.json` contient les chemins et SHA-256 des
fichiers gérés. L'export refuse de remplacer un dossier non vide non géré,
de suivre un lien symbolique ou d'écraser un fichier géré modifié à la main.
Il ne retire que les fichiers présents dans son précédent manifeste ; les
autres fichiers et `.git` restent conservés. Il faut modifier les sources,
puis relancer la synchronisation. Un arrêt pendant la copie peut demander
de rétablir le miroir depuis une destination vide ; la source reste intacte.

## Avant le premier push

Le contrôle de secrets intégré détecte des signatures usuelles, sans garantir
l'absence de toute donnée privée. Examiner la sélection, vérifier les liens et
licences, effectuer un build depuis le miroir et contrôler les audits. Le choix
GPL ne requalifie pas automatiquement les images, modèles et composants tiers.
Voir [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

Créer et pousser le dépôt constitue une opération distincte. Le script ne fait
ni `git init`, ni commit, ni push. Les clés et endpoints de signature/catalogue
doivent être ceux de l'éditeur des binaires distribués.
