# Avatar GLB personnalisé — contrat Blender de Lumen

Lumen accepte un avatar 3D personnalisé sous la forme d'un **unique fichier
GLB glTF 2.0**. Le maillage, le squelette, les matériaux, les textures et toutes
les animations doivent être intégrés dans ce fichier.

Cette convention porte le nom **Lumen Avatar Animation Contract v1**. Les noms
de clips ci-dessous forment une API : ils sont stables, obligatoires et
sensibles à la casse.

## Animations à créer dans Blender

| Nom exact de l'Action Blender | Requis | Boucle | Utilisation dans Lumen |
| --- | --- | --- | --- |
| `Lumen_Idle` | oui | oui | L'assistant attend. Une respiration ou un mouvement discret est recommandé. |
| `Lumen_Thinking` | oui | oui | Une réponse est en cours de génération. |
| `Lumen_Speaking` | oui | oui | La synthèse vocale joue la réponse. |
| `Lumen_Action` | oui | oui | Lumen exécute un outil ou une action Fluxo. |
| `Lumen_Heartbeat` | non | non | Animation ponctuelle lors d'un Heartbeat. En son absence, Lumen conserve l'animation courante. |

Les quatre animations requises doivent exister, même si certaines partagent
temporairement les mêmes images clés. Lumen effectue un fondu d'environ 0,22 s
entre les clips. Il ne déduit jamais une animation depuis son ordre dans le
fichier.

## Préparer le fichier dans Blender

1. Placez l'avatar à l'origine de la scène. Utilisez `Z` comme axe vertical et
   faites regarder le personnage vers `-Y`, convention d'export glTF de Blender.
2. Appliquez les transformations du maillage et de l'armature avec
   **Object > Apply > Rotation & Scale** (`Ctrl+A`). Une échelle Blender régulière
   est suffisante : Lumen recentre et redimensionne automatiquement le modèle.
3. Créez une **Action** distincte dans le Dope Sheet > Action Editor pour chaque
   nom du tableau. Saisissez le nom exactement, sans suffixe `.001`, espace ou
   changement de casse.
4. Activez le bouclage des quatre Actions requises. La dernière pose doit
   rejoindre naturellement la première ; il est préférable de ne pas dupliquer
   deux fois la même image de fin.
5. Pour garantir l'export de chaque Action, poussez-les dans des pistes du
   **NLA Editor** ou conservez-les avec **Fake User**. Nommez aussi les pistes NLA
   comme les Actions correspondantes.
6. Utilisez des matériaux Principled BSDF compatibles glTF. Les textures doivent
   être accessibles dans Blender avant l'export ; le format GLB les embarquera.

Les animations peuvent piloter une armature, des morph targets (shape keys) ou
des transformations d'objets. Toutes les données animées doivent appartenir à
la scène exportée.

## Exporter depuis Blender

Ouvrez **File > Export > glTF 2.0**, puis utilisez les réglages suivants :

- **Format** : `glTF Binary (.glb)` ;
- **Include** : objets visibles, ou `Selected Objects` si toute la hiérarchie de
  l'avatar est sélectionnée ;
- **Data > Mesh** : UVs, Normals et Shape Keys selon le modèle ;
- **Data > Armature** : `Export Deformation Bones Only` recommandé ;
- **Animation** : activée ;
- **Animation > Mode** : `NLA Tracks` pour exporter les pistes préparées, ou
  `Actions` selon la version de Blender ;
- **Animation > Always Sample Animations** : activé si les contraintes ou les
  drivers ont été utilisés ;
- **Animation > Group by NLA Track** : activé lorsque proposé.

N'activez une compression Draco ou Meshopt que si elle a été testée dans
Lumen. Un GLB standard non compressé est le choix le plus portable. La taille
maximale acceptée est **25 Mo**.

## Importer et valider dans Lumen

Dans **Paramètres > Avatar** :

1. choisissez **GLB personnalisé** ;
2. cliquez sur **Choisir un GLB…** ;
3. sélectionnez le fichier exporté ;
4. attendez le message **contrat Lumen valide ✓**, puis enregistrez les
   paramètres.

Lumen vérifie le conteneur GLB, la version glTF 2.0 et les quatre noms
d'animations avant de remplacer l'ancien avatar. Un fichier refusé ne remplace
pas le GLB précédemment installé.

### Réglages propres au GLB

Le curseur **Lumière ambiante du GLB** dans **Paramètres > Avatar** ajuste
l'éclairage du personnage de 0 à 250 %. Il n'a aucun effet sur l'orbe Lumen.

Lumen n'ajoute ni flottement ni rebond au modèle personnalisé : sa position ne
change que si l'animation Blender active contient elle-même un déplacement. Le
cercle givré, l'ombre et la lueur ambiante de l'orbe sont également masqués en
mode GLB, puis restaurés automatiquement en revenant au type **Orbe Lumen**.

## Checklist avant livraison

- Le fichier se termine par `.glb`, pas `.gltf`.
- Les textures sont visibles lorsque le GLB est ouvert sur une autre machine.
- Les quatre noms requis apparaissent exactement dans l'export.
- Chaque boucle revient sans saut à sa première pose.
- Aucun objet de travail, caméra ou lumière Blender inutile n'est exporté.
- Le modèle fait moins de 25 Mo et reste raisonnable en nombre de polygones et
  en résolution de textures pour un rendu temps réel.

### Problèmes courants

**Une animation est annoncée manquante** : inspectez le nom de l'Action et de
la piste NLA. Blender peut ajouter `.001` après une duplication.

**Une seule animation est exportée** : poussez chaque Action dans une piste NLA
non muette, ou activez son Fake User, puis réexportez en mode NLA Tracks.

**Le modèle est gris** : les images n'étaient probablement pas chargées ou le
matériau n'est pas compatible glTF. Reconnectez les textures à un Principled
BSDF et exportez de nouveau en GLB.

**L'avatar regarde de côté** : corrigez son orientation en mode Object, appliquez
Rotation & Scale, puis réexportez. Lumen ne modifie pas l'orientation artistique
du personnage.
