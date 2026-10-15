# Boîtier Lumen Pi — finitions Or et Rouge

Boîtier paramétrique pour Raspberry Pi 4 B et Pi 5, dans la grammaire de
l'habillage Lumen Pro : **coque noire, métal en soulignement**. La couleur ne
couvre pas la pièce — elle tient dans une plaque d'insert encastrée en biais sur
le couvercle, gravée « LUMEN ».

## Trois pièces, deux filaments

| Pièce | Filament | Rôle |
|---|---|---|
| `shell` | noir | Coque, entretoises, ouvertures des connecteurs |
| `lid` | noir | Couvercle encliquetable, logement de l'insert |
| `insert` | or **ou** rouge | La plaque de finition, gravée |

Aucune imprimante multi-matière n'est nécessaire : trois pièces, imprimées
séparément, clipsées à la main. C'est aussi ce qui rend le boîtier réparable —
un insert rayé se réimprime seul, et la coque ne bouge pas.

La coque et le couvercle sont **identiques d'une finition à l'autre** : on peut
imprimer un lot de coques et décider de la couleur plus tard.

## Produire les STL

```sh
./export-stl.sh              # Pi 5, dans ./stl
BOARD=pi4 ./export-stl.sh    # Pi 4 B
```

OpenSCAD n'est pas une dépendance de Lumen : installez-le sur la machine qui
imprime (`brew install --cask openscad`, `apt install openscad`).

## Impression

* **PETG ou ASA**, pas de PLA : un Pi 5 sous charge dépasse allègrement la
  température à laquelle le PLA commence à fluer.
* Buse 0,4 mm · couches 0,2 mm · 3 parois · 20 % de remplissage.
* **Aucun support** : les aérations sont en losange et les surplombs
  chanfreinés, précisément pour cela.
* Coque posée fond en bas ; couvercle posé face extérieure en bas (la gravure de
  l'insert sort alors nette).

## Réglages

En tête du `.scad` :

| Variable | Défaut | Pourquoi y toucher |
|---|---|---|
| `BOARD` | `"pi5"` | Le Pi 5 déplace l'Ethernet et supprime le jack : les ouvertures diffèrent |
| `FLAVOR` | `"gold"` | Couleur d'aperçu de l'insert (ne change pas la géométrie) |
| `CLEARANCE` | `0,25 mm` | Augmentez si vos pièces s'emboîtent trop serré |
| `WALL` | `2,4 mm` | Trois parois à la buse 0,4 |

## Refroidissement

Le fond est ajouré sous la carte, les deux longs côtés le sont aussi : l'air
entre par-dessous et ressort sur les côtés. Une fenêtre laisse passer une nappe
GPIO.

Cela suffit à un Pi 5 en usage bureautique (Lumen en mode borne). Pour une
charge soutenue — inférence locale, compilation — **ajoutez un ventilateur** :
le boîtier ne prétend pas refroidir passivement un Pi 5 à pleine puissance, et
prétendre le contraire vous coûterait des ralentissements silencieux.

## Non vérifié

La géométrie n'a **pas été rendue** : OpenSCAD n'était pas installé sur la
machine de développement. Le fichier est structurellement correct et les cotes
viennent de la mécanique officielle du Raspberry Pi, mais **imprimez d'abord la
coque seule** et présentez-y la carte avant de lancer le jeu complet.
