# Exporter les sources

Le script `scripts/export-source.py` crée une copie portable des sources.
Il est facultatif pour compiler Lumen depuis ce dépôt.

```bash
npm run source:plan                 # aperçu sans copie
npm run source:sync                 # export dans public-source/
python3 scripts/export-source.py --out /chemin/vers/lumen-public
```

## Contenu de l’export

La liste des répertoires inclus est définie par `ROOTS` dans le script.
Les caches, modèles, binaires précompilés et configurations locales sont exclus.
Le script génère un `dev.sh` portable et neutralise les paramètres Wi-Fi des
firmwares. Les ressources graphiques présentes dans l’export peuvent différer
selon leurs droits de redistribution ; choisissez un avatar disponible.

## Synchronisations suivantes

Le marqueur `.lumen-source-export.json` conserve les chemins et empreintes
SHA-256 des fichiers gérés. Le script refuse de remplacer un dossier non vide
non géré, de suivre un lien symbolique ou d’écraser un fichier géré modifié
manuellement. Il retire uniquement les fichiers de son précédent manifeste ;
les autres fichiers et `.git` sont conservés.

Modifiez les sources, puis relancez la synchronisation. Après une interruption,
il peut être nécessaire de recommencer vers un dossier vide.

## Vérification et distribution

Le contrôle de secrets détecte des signatures usuelles et des configurations
Wi-Fi, sans garantir l’absence de toute donnée sensible. Vérifiez les fichiers
sélectionnés avant de les partager. Le script ne crée aucun commit et ne pousse
rien sur Internet.

Pour distribuer des binaires, configurez vos propres clés de signature et
endpoints de catalogue et de mise à jour. Conservez les licences tierces et
fournissez les sources correspondant à la version distribuée :
[notices](../THIRD_PARTY_NOTICES.md), [build](../BUILDING.md),
[release](release.md).
