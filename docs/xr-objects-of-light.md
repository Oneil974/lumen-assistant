# Lumen XR — Objets de lumière

La scène XR utilise désormais des objets sculptés : dossiers articulés, documents aux coins arrondis, icônes colorées à plusieurs couches, dock courbe et espaces de travail des agents.

## Utilisation

- **Apps** dans la barre ouvre le dock 3D. **Suite** affiche sa deuxième page. Il se range après une période d'inactivité ; le bouton Apps et la paume levée le rappellent.
- **Dossiers** affiche les sandboxes, les étagères et l'équipe. Pincez un dossier pour l'ouvrir ; saisissez un fichier pour le déplacer. Les couvertures réagissent au survol.
- **Ranger** place les dossiers sur les étagères. Une étagère se déplace par sa base ; ses dossiers suivent. Les positions et leurs associations sont mémorisées localement.
- **Documents** : les fichiers ouverts affichent un extrait réel, ou une miniature des images compatibles. Un appui ouvre un lecteur Markdown ; molette, joystick, boutons et glissement du doigt permettent de défiler.
- **Rechercher** recherche les noms des dossiers et des fichiers actuellement déployés. La saisie fonctionne par dictée ou clavier. Les objets correspondants s'illuminent ; les résultats apparaissent en cartes 3D.
- **Agents** : déposez un fichier ou un dossier près d'une figurine pour lui confier une tâche. Les documents reçus restent visibles sur son espace de travail. La petite pile de documents à sa droite ouvre son dernier compte rendu ; la figurine reste disponible pour une nouvelle tâche.
- **Notifications** : les messages arrivent sous forme d'enveloppes. Un appui fait sortir la lettre et ouvre le lecteur. Au plus quatre enveloppes restent présentes ; l'historique complet est conservé dans le panneau Notifications.
- **Calendrier** et **Galerie** ouvrent les vues des applications installées. Une application absente est signalée dans le panneau Apps.
- **Épingle** dans l'en-tête d'un panneau : prévisualisation du mur au survol, fixation au clic. **Annuler** restaure sa position précédente.
- **Réglages** : texte de lecture de 24 à 36 px, contraste renforcé, animations réduites et qualité adaptative. Les réglages se parcourent par défilement ou flèches.
- Une dictée comportant des verbes d'envoi, de publication, d'achat ou de suppression affiche le texte à confirmer ou redicter avant son aiguillage.

## Architecture et budget de rendu

`src/xr-design.js` fournit 17 familles d'icônes, les volumes arrondis, les matériaux partagés, les ombres de contact et leur gestion de ressources. Aucun post-traitement bloom, passe de transmission ou carte d'ombre dynamique n'est nécessaire.

`src/xr-light-desk.js` relie ces objets aux applications, au lecteur, à la recherche, aux notifications et aux transitions. `xr-props.js` conserve la physique et les interactions des fichiers ; `xr-belt.js` utilise le même vocabulaire visuel pour les outils.

Les aperçus se chargent à deux requêtes simultanées, une en mode performance. Les images conservées sont réduites à 512 px et le cache est borné à 40 entrées. L'animation des bouches est limitée à 20 Hz, 10 Hz en mode performance. La qualité adaptative réduit progressivement la densité des panneaux et augmente la fovéation lorsque le rythme des images XR se dégrade ; elle rétablit la qualité après une période stable.

L'éclairage réel utilise l'estimation WebXR lorsqu'elle est disponible. Sinon, l'éclairage doux de la scène reste actif. Les contrôles de profondeur et le scan de pièce existants restent utilisés pour le placement.

## Validation

```sh
node --test scripts/test-xr-design.mjs scripts/test-xr-markdown.mjs scripts/test-xr-speech-check.mjs scripts/test-voice-mouth.mjs scripts/test-research-markdown.mjs
python3 -m http.server 8786 --bind 127.0.0.1 --directory src
```

- `/__preview-light-design.html` : collection interactive des véritables icônes utilisées en XR, avec rotation.
- `/__preview-light-xr.html` : scène réelle avec données locales simulées.
- `/__preview-light-xr.html?test=1` : parcours d'intégration automatique. L'indicateur PASS vérifie les dossiers, fichiers, lecteur, notifications, calendrier, recherche, compte rendu d'agent et déplacement d'une étagère. Aucune action sur des données réelles.

Les nouveaux modules sont intégrés à la table d'assets native du compagnon : l'application doit être recompilée pour les servir au casque.

Les tests navigateur ne valident pas le suivi des mains, le passthrough, le scan de pièce, la profondeur ni le nombre d'images par seconde du Quest. Ces points nécessitent une session sur le casque. La compilation native locale est également à vérifier avec un Rust compatible avec les dépendances du projet ; le Rust 1.86 installé ici est trop ancien.
