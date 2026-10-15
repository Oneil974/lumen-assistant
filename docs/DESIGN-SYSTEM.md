# Apparence de Lumen — une seule source

Avant, l'apparence était éparpillée : deux réglages clair/sombre, quatre scripts
d'amorçage chargés dans un ordre différent selon les pages, et autant d'échelles
d'ombres qu'il y avait de surfaces. Le symptôme se voyait à l'œil nu — une barre
de chat claire au-dessus d'un bureau sombre, une fenêtre qui s'ouvrait en neutre
puis sautait sur la teinte choisie, deux cartes au même plan portant des ombres
différentes.

## Un seul clair/sombre

Il y avait **deux** réglages : « Barre de chat » (`themePreference`) et
« Interface » (`dtTheme`). Deux réponses possibles à une question que personne ne
se pose en ces termes.

Il n'y en a plus qu'un : `lumenTheme` ∈ `light | dark | auto`. Le bouton
lune/soleil de la barre, celui du bureau et le sélecteur des Paramètres pilotent
tous le même. `auto` suit le système, **y compris quand il bascule en cours de
session** (`prefers-color-scheme` est écouté, pas seulement lu au démarrage).

Les anciennes clés continuent d'être écrites tant que des surfaces les lisent
(la capsule, le bureau par profil), et sont relues une fois pour la migration :
personne ne perd son choix.

## Un seul amorçage

`src/lib/theme-init.js` remplace `dt-theme-init.js`, son quasi-jumeau
`dt-theme-accent-init.js` (58 lignes identiques à une purge près),
`ui-theme-init.js` et la partie thème de `pro-edition-init.js`. **50 pages** le
chargent, une seule fois chacune, avant la première feuille de style.

Il pose tout l'état d'apparence sur `<html>`, en un passage :

| Attribut | Valeur |
|---|---|
| `data-theme` | `light` \| `dark` — toujours **résolu**, jamais `auto` |
| `data-dt-theme` | idem — alias historique, lu par 84 règles de `tokens.css` |
| `data-ui-base` | teinte des gris |
| `data-ui-accent` | couleur d'action |
| `data-ui-icons` | habillage des pastilles |
| `data-edition` / `data-pro-flavor` | édition Pro |
| `--radius` | rayon de base |

`src/lib/theme.js` est l'**API** : `themePreference()`, `resolvedTheme()`,
`setTheme()`, `readAppearance()`, `setAppearance()`, `onAppearanceChange()`.
C'est le seul endroit d'où l'on écrit — `ui-customizer.js` n'est plus qu'une
interface de réglage et lui délègue son stockage.

Une app packagée vit sur une autre origine : elle ne peut pas lire ces
attributs. Le bureau les lui **envoie** par le pont AppKit, au chargement et à
chaque changement (`lumen.ui.theme()` côté app, événement `theme` poussé).

## Une seule échelle d'élévation

Cinq jetons dans `lib/tokens.css`, et rien d'autre. Le niveau dit à quelle
**hauteur** flotte la surface, pas à quel point elle doit se remarquer :

| Jeton | Plan | Exemples |
|---|---|---|
| `--shadow-1` | posé | champs, cartes au repos |
| `--shadow-2` | flottant | barre de chat, barres d'outils |
| `--shadow-3` | détaché | menus, popovers, fenêtres |
| `--shadow-4` | au-dessus de tout | modales, feuilles de consentement |
| `--shadow-focus` | anneau de focus | teinté par la couleur d'action |
| `--rim` | liseré interne | l'arête de la surface |

En thème sombre, les valeurs sont **remplacées**, pas réutilisées : une ombre
calculée pour le clair s'y écrase en halo gris. C'est le liseré (`--rim`) qui
porte le relief. `lib/__preview-elevation.html` montre l'échelle dans les deux
thèmes — à ouvrir avant d'écrire une `box-shadow`. Si aucun niveau ne convient,
c'est presque toujours que la surface n'est pas au plan qu'on croit, pas qu'il
manque une valeur.

Les trois noms de `flat.css` (`--flat-shadow-sm/md/lg`) sont devenus des alias :
ils restent parce que des dizaines de feuilles les nomment, mais ne définissent
plus de valeurs propres — sinon le thème sombre les laissait figées.

### L'ombre de la barre de chat

Elle portait `0 12px 30px rgba(0,0,0,.12)` sur un fond translucide, et son état
focus montait à `0 16px 35px / 20 %` — la barre sautait d'un étage à chaque clic
dans le champ. Elle utilise désormais `--shadow-2` au repos **et** au focus ; ce
qui signale le focus, c'est l'anneau (`--shadow-focus`), pas une élévation.
Le panneau de messages et le mode opaque suivent le même jeton, pour que
basculer une option ne change pas la profondeur perçue.
