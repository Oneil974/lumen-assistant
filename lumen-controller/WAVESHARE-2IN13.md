# Lumen Controller — câblage, flash et mise en route

Ce guide décrit le montage complet avec :

- un ESP32 DevKit **ou** un Raspberry Pi Pico W ;
- un Waveshare 2.13inch e-Paper HAT **V3/V4 noir/blanc**, 250×122 ;
- un encodeur rotatif mécanique pour choisir le modèle ;
- un potentiomètre linéaire de 10 kΩ pour le volume ;
- trois boutons momentanés : Backend, Mic et Mode ;
- le poussoir intégré de l'encodeur : choisit ce que pilote la molette ;
- un bandeau de LEDs WS2812B : indique l'état de Lumen.

La variante Pico sans suffixe **W** n'a pas de Wi-Fi et nécessite un module
réseau externe. Les écrans Waveshare marqués `(B)` ou `(G)` ne sont pas
compatibles avec ce pilote. Le module photographié porte bien l'autocollant V4,
donc le mode V4 est utilisé par défaut.

## Matériel conseillé

| Quantité | Composant |
|---:|---|
| 1 | ESP32 DevKit/WROOM ou Raspberry Pi Pico W |
| 1 | Waveshare 2.13inch e-Paper HAT V3/V4 noir/blanc |
| 1 | encodeur rotatif EC11 ou module KY-040 compatible 3,3 V |
| 1 | potentiomètre linéaire B10K, 10 kΩ |
| 3 | boutons poussoirs momentanés normalement ouverts |
| — | (le 4e bouton est le poussoir intégré de l'encodeur) |
| 1 | bandeau/anneau WS2812B (NeoPixel), 3 LEDs par défaut |
| 1 | breadboard ou PCB |
| — | fils Dupont |
| 1 | câble USB de données |

Tous les composants doivent partager la même masse GND. Ne branchez ou
débranchez pas l'écran lorsque la carte est alimentée.

## Vue fonctionnelle

```text
Encodeur modèle ─┐
Potentiomètre ────┼──> ESP32 / Pico W ──Wi-Fi──> Lumen
4 boutons ────────┤           ├──────> LEDs WS2812B
                  └───────────┴──SPI──> écran e-paper
```

## Câblage ESP32 DevKit

Le profil ci-dessous correspond directement au `config.py` fourni.

### Écran Waveshare

Utilisez le connecteur SPI 8 broches du HAT. Le connecteur Raspberry Pi
40 broches ne doit pas être enfiché sur l'ESP32.

| Écran | Fonction | ESP32 |
|---|---|---|
| VCC | alimentation | 3V3 |
| GND | masse | GND |
| DIN | SPI MOSI | GPIO13 |
| CLK | SPI SCK | GPIO14 |
| CS | sélection écran | GPIO15 |
| DC | donnée/commande | GPIO2 |
| RST | reset écran | GPIO16 |
| BUSY | état écran | GPIO17 |

Le HAT accepte 3,3 V/5 V grâce à son translateur, mais utilisez 3,3 V avec
l'ESP32. GPIO2 et GPIO15 sont des broches de démarrage sur certaines cartes :
si la carte ne boote pas, déplacez DC et CS vers deux GPIO libres puis modifiez
`EPD_PIN_DC` et `EPD_PIN_CS` dans `config_local.py`.

### Encodeur rotatif du modèle

| Encodeur nu | Module KY-040 | ESP32 |
|---|---|---|
| commun C | GND | GND |
| sortie A | CLK | GPIO32 |
| sortie B | DT | GPIO33 |
| — | + / VCC | 3V3 |
| poussoir | SW | GPIO19 |

Le poussoir intégré de l'encodeur fait tourner ce sur quoi agit la molette :
**modèle → voix → couleur des LEDs**. L'étiquette `ENC …` en bas à droite de
l'écran rappelle la fonction active. Il se câble comme les autres boutons,
entre son GPIO et GND ; la pull-up interne est activée par le firmware.

Les entrées utilisent les résistances pull-up internes. Si la rotation semble
inversée, définissez `ENCODER_REVERSED = True` dans `config_local.py` (ou
échangez A et B).

L'encodeur est décodé **par interruption**, pas par scrutation : un cran
produit quatre transitions en quelques dizaines de millisecondes, que la
boucle principale — qui tourne toutes les 80 ms et se bloque pendant chaque
rafraîchissement de l'écran — manquerait presque intégralement.

N'alimentez pas un module KY-040 en 5 V : ses sorties pourraient envoyer 5 V
aux entrées de l'ESP32.

### Potentiomètre de volume

Vu côté axe, les numéros gauche/droite peuvent dépendre du fabricant. Le
curseur est toujours la patte centrale.

| Potentiomètre B10K | ESP32 |
|---|---|
| extrémité 1 | 3V3 |
| curseur, patte centrale | GPIO34 / ADC |
| extrémité 2 | GND |

GPIO34 appartient à ADC1, utilisable pendant que le Wi-Fi fonctionne. Ne
mettez jamais 5 V sur cette entrée. Si le volume monte quand on tourne vers le
moins, permutez les deux extrémités ou définissez
`VOLUME_REVERSED = True`.

### Les boutons

Chaque bouton est câblé entre son GPIO et GND. Aucune résistance externe n'est
nécessaire : le firmware active la pull-up interne.

| Bouton | Première patte | Deuxième patte |
|---|---|---|
| Backend | GPIO4 | GND |
| Mic | GPIO5 | GND |
| Mode de discussion | GPIO18 | GND |
| SW de l'encodeur | GPIO19 | GND |

**Backend** distingue l'appui court (backend suivant) de l'appui long
d'environ 0,7 s (charge le modèle en mémoire). Ce seuil se règle avec
`BUTTON_LONG_MS`.

Sur un bouton tactile à quatre pattes, les deux pattes d'un même côté sont déjà
reliées. Utilisez une patte de chaque côté du bouton.

### Récapitulatif ESP32

| Élément | GPIO |
|---|---:|
| e-paper DIN / CLK / CS / DC / RST / BUSY | 13 / 14 / 15 / 2 / 16 / 17 |
| encodeur A / B | 32 / 33 |
| potentiomètre | 34 |
| Backend / Mic / Mode | 4 / 5 / 18 |
| poussoir de l'encodeur (SW) | 19 |
| données des LEDs WS2812B | 27 |

## Broches restantes sur le Pico W

Après le montage complet, 12 GPIO restent libres : **GP0, GP1, GP4, GP5, GP6,
GP7, GP19, GP20, GP21, GP22, GP27, GP28**. `GP23`, `GP24`, `GP25` et `GP29`
sont réservés en interne sur un Pico W et ne sont pas utilisables.

De quoi ajouter un **lecteur RFID** sans rien déplacer. Le bus **SPI0 est
entièrement libre**, et l'écran occupe SPI1 : les deux périphériques ne
partagent donc aucune ligne, ce qui évite toute contention de `CS`.

Câblage pour un module **MFRC522** (le RobotDyn porte 10 broches, contre 8 sur
le module bleu classique : il ajoute `5V` et `PWR`) :

| MFRC522 | Pico W | Broche physique | Remarque |
|---|---|---:|---|
| SDA (= CS) | GP5 | 7 | piloté à la main, comme pour l'écran |
| SCK | GP6 | 9 | SCK par défaut de SPI0 |
| MOSI | GP7 | 10 | |
| MISO | GP4 | 6 | |
| IRQ | GP21 | 27 | facultatif, non utilisé en scrutation |
| GND | GND | 8 | |
| RST | GP22 | 29 | |
| 3.3V | 3V3 OUT | 36 | **alimenter ici** |
| 5V | — | — | ne pas connecter si 3.3V est utilisé |
| PWR | — | — | laisser libre |

Le MFRC522 est un composant 3,3 V : aucune adaptation de niveau n'est
nécessaire avec le Pico. N'alimentez **pas** `3.3V` et `5V` en même temps ; la
broche `5V` n'existe que pour les cartes qui régulent elles-mêmes.

Sur les modules RobotDyn, trois pastilles à souder marquées `1 2 3` choisissent
l'interface (SPI, I²C, UART). La configuration d'usine est SPI ; si le lecteur
ne répond pas, c'est le premier point à vérifier.

Le pilote `mfrc522.py` et le module `rfid.py` sont fournis : copiez-les sur la
carte comme les autres fichiers. Pour se passer du lecteur,
`RFID_PIN_CS = None` dans `config_local.py`.

Au démarrage, la console affiche `RFID: MFRC522 detecte (VersionReg=0x92)`.
Un `VersionReg` à `0x00` ou `0xFF` signifie que le bus répond mais pas la
puce : vérifiez l'alimentation 3,3 V, puis les cavaliers `1 2 3` du module.

Il resterait encore GP0, GP1, GP19, GP20, GP27 et GP28.

**Piège à ne pas répéter** : construisez l'objet `SPI(0)` **avant** les `Pin` de
`CS` et `RST`. MicroPython applique les broches par défaut du bus (dont MISO) au
moment du `SPI()` et confisque le pad, ce qui rendrait un `Pin` créé plus tôt
inopérant. C'est exactement la panne qui a empêché l'écran de fonctionner au
départ, décrite plus bas dans le dépannage.

## Câblage Raspberry Pi Pico W

Le firmware détecte automatiquement `sys.platform == "rp2"` et active ce
profil. Il n'est donc plus nécessaire de recopier les GPIO dans
`config_local.py`, sauf pour un câblage personnalisé.

### Écran Waveshare

| Écran | Pico W | Broche physique |
|---|---|---:|
| VCC | VSYS (alimentation USB) | 39 |
| GND | GND | 38, ou autre GND |
| DIN | GP11 / SPI1 TX | 15 |
| CLK | GP10 / SPI1 SCK | 14 |
| CS | GP9 | 12 |
| DC | GP8 | 11 |
| RST | GP12 | 16 |
| BUSY | GP13 | 17 |

Avec la nappe colorée visible sur le HAT Waveshare Rev 2.1/V4, utilisez
précisément cette correspondance :

| Couleur de la nappe | Signal HAT | Pico W | Broche physique |
|---|---|---|---:|
| gris | VCC | VSYS | 39 |
| marron | GND | GND | 13 |
| bleu | DIN | GP11 | 15 |
| jaune | CLK | GP10 | 14 |
| orange | CS | GP9 | 12 |
| vert | DC | GP8 | 11 |
| blanc | RST | GP12 | 16 |
| violet | BUSY | GP13 | 17 |

À l'exception du fil gris VCC, les sept autres connexions occupent donc une
suite presque continue sur **un seul côté** du Pico : 11, 12, 13, 14, 15, 16,
17. Le fil gris va seul sur le côté opposé, broche 39. Comptez toujours les
broches physiques depuis l'extrémité USB en vous aidant de la sérigraphie ;
ne confondez pas `GP13` avec la broche physique 13.

`VSYS` fournit environ la tension USB au circuit d'alimentation du HAT. Ne
branchez jamais `VSYS` sur une entrée GPIO, le potentiomètre ou l'encodeur :
ces éléments restent alimentés par `3V3 OUT`.

### Encodeur, potentiomètre et boutons

| Élément | Pico W | Broche physique |
|---|---|---:|
| encodeur commun / GND | GND | 3, ou autre GND |
| encodeur A / CLK | GP2 | 4 |
| encodeur B / DT | GP3 | 5 |
| potentiomètre extrémité 1 | 3V3 OUT | 36 |
| potentiomètre curseur | GP26 / ADC0 | 31 |
| potentiomètre extrémité 2 | GND | 33 |
| bouton Backend | GP14 vers GND | 19 |
| bouton Mic | GP15 vers GND | 20 |
| bouton Mode | GP16 vers GND | 21 |
| poussoir de l'encodeur (SW) | GP17 vers GND | 22 |
| LEDs WS2812B, données DIN | GP18 | 24 |

Alimentez également un éventuel module encodeur avec 3V3 OUT et GND. Sa broche
SW va sur GP17 : une pression fait tourner ce que pilote la molette (modèle →
voix → couleur des LEDs). Pour ne pas l'utiliser, définir
`BUTTON_ENCODER = None` dans `config_local.py`.

### Bandeau WS2812B

| Bandeau | Pico W | Broche physique |
|---|---|---:|
| VCC / 5V | VBUS (5 V USB) | 40 |
| GND | GND | 38, ou autre GND |
| DIN | GP18 | 24 |

Les WS2812B sont prévus pour 5 V. Un signal de données à 3,3 V est accepté par
la plupart des bandeaux ; si le premier pixel scintille, intercalez un
adaptateur de niveau, ou alimentez le bandeau en 3,3 V au prix d'une
luminosité réduite.

**Ne dépassez pas 3 LEDs sur l'alimentation de la carte.** Un WS2812B tire
jusqu'à 60 mA à pleine puissance en blanc : trois LEDs approchent déjà 200 mA,
et huit dépasseraient un demi-ampère, bien au-delà de ce que fournit le port
USB via le Pico. Au-delà de trois, utilisez une alimentation 5 V dédiée, masse
commune avec la carte, et baissez `LED_BRIGHTNESS` si les LEDs scintillent ou
si la carte redémarre. `LED_COUNT` vaut 3 et `LED_BRIGHTNESS` 50 % par défaut.

Pour s'en passer entièrement : `LED_PIN = None` dans `config_local.py`.

### `config_local.py` minimal pour Pico W

```python
WIFI_SSID = "MON_WIFI"
WIFI_PASSWORD = "MON_MOT_DE_PASSE"
```

Au démarrage, la console doit afficher `Hardware profile: Pico W / RP2`. Si
elle affiche ESP32 sur un Pico W, remplacez `config.py` sur la carte par la
version la plus récente.

## Préparer `config_local.py` pour ESP32

Créez ce fichier dans `lumen-controller` sans placer le mot de passe Wi-Fi dans
`config.py` :

```python
WIFI_SSID = "MON_WIFI"
WIFI_PASSWORD = "MON_MOT_DE_PASSE"
```

Les autres valeurs sont déjà celles du tableau ESP32.

### Retourner l'affichage

Selon le côté où sort la nappe, l'écran peut se retrouver tête-bêche :

```python
EPD_ROTATION = 180
```

Le retournement se fait dans le pilote, sur le flux envoyé à la dalle :
inverser l'ordre des octets échange les lignes, inverser les bits de chaque
octet échange les pixels, et les deux combinés donnent exactement une rotation
de 180°. Une table de 256 entrées est construite au chargement — recalculer
2000 inversions à chaque rafraîchissement serait bien trop lent.

Le décalage vertical du dessin s'inverse en même temps : les 6 lignes qui
n'existent pas sur la dalle sont rognées en **haut** en orientation normale, et
en **bas** une fois l'image retournée. `ui.py` s'en charge tout seul ;
`EPD_Y_OFFSET` permet malgré tout de forcer une valeur.

## Installer les outils

Sur l'ordinateur :

```sh
python3 -m pip install --upgrade mpremote esptool
```

Téléchargez une version stable de MicroPython :

- ESP32/WROOM : <https://micropython.org/download/ESP32_GENERIC/>
- Pico W : <https://micropython.org/download/RPI_PICO_W/>

## Flasher MicroPython sur ESP32

Débranchez l'écran pendant le premier flash. Branchez l'ESP32 avec un câble USB
de données, puis exécutez :

```sh
python3 -m esptool erase_flash
python3 -m esptool --baud 460800 write_flash 0x1000 ESP32_GENERIC-VERSION.bin
```

Si la détection automatique échoue, ajoutez `--port /dev/cu...` sur macOS,
`--port /dev/ttyUSB0` sur Linux, ou `--port COM4` sur Windows. Si l'écriture
échoue à 460800 bauds, retirez `--baud 460800`.

## Flasher MicroPython sur Pico W

1. Débranchez le Pico W.
2. Maintenez le bouton `BOOTSEL`.
3. Rebranchez l'USB, puis relâchez `BOOTSEL`.
4. Un volume nommé `RPI-RP2` apparaît.
5. Copiez le fichier `.uf2` MicroPython Pico W sur ce volume.
6. Le volume disparaît automatiquement lorsque la carte redémarre.

## Copier le firmware Lumen

Rebranchez le montage complet, placez-vous dans le dossier
`lumen-controller`, puis copiez les fichiers :

```sh
mpremote connect auto fs cp config.py :
mpremote connect auto fs cp config_local.py :
mpremote connect auto fs cp input.py :
mpremote connect auto fs cp net.py :
mpremote connect auto fs cp ui.py :
mpremote connect auto fs cp leds.py :
mpremote connect auto fs cp epd2in13_v4.py :
mpremote connect auto fs cp mfrc522.py :
mpremote connect auto fs cp rfid.py :
mpremote connect auto fs cp main.py :
mpremote connect auto reset
```

Pour afficher la console série :

```sh
mpremote connect auto
```

Quittez la console avec `Ctrl-]`. Aucun module graphique supplémentaire n'est
requis : le pilote Waveshare est inclus.

## Premier démarrage

1. L'écran clignote en noir/blanc pendant le rafraîchissement complet initial.
2. Le contrôleur rejoint le Wi-Fi. Son adresse IP s'affiche **sur l'écran**,
   à la place de la ligne d'état, tant que Lumen n'est pas connecté ; elle
   est aussi imprimée sur la console série.
3. Dans Lumen, renseignez cette IP comme hôte du bridge et gardez le port 8787.
4. Tournez l'encodeur : le modèle change.
5. Appuyez sur Backend : Ollama, llama.cpp/llama-server, Apple et API défilent.
6. Tournez le potentiomètre : la valeur de volume affichée suit sa position.
7. Testez Mic et Desktop.
8. Maintenez **Backend** environ une seconde : l'écran affiche `Loading` et
   les LEDs passent au violet pendant que Lumen charge le modèle en mémoire,
   puis tout revient à `Ready`.
9. Appuyez sur l'axe de l'encodeur : l'étiquette `ENC` passe de `MODEL` à
   `VOICE` puis `LED`, et la molette agit sur la valeur correspondante.
10. Appuyez sur **Mode** : le mode de discussion défile en bas à droite
   (`CHAT`, `ROUTER`, `TOOLS`, `DOCS`).

Le backend `llama` utilise les fichiers GGUF gérés par Lumen et démarre son
`llama-server` local.

### Catalogue des modèles

La liste que fait défiler la molette est **récupérée automatiquement** auprès
de Lumen. Dès que l'application se connecte, elle pousse un message
`{"type":"catalog"}` construit à partir des modèles réellement installés :
`llama_list_models` pour les GGUF, `ollama_list_models` pour Ollama, et le
modèle configuré pour le backend `api`. Le catalogue est ensuite re-scruté
toutes les 60 secondes, donc un modèle fraîchement téléchargé apparaît sans
redémarrer le contrôleur. La console de la carte affiche à chaque mise à jour :

```text
catalogue: ollama=7, llama=3, apple=1, api=1
```

Les listes de `config.py` ne servent plus que de **repli** avant la première
connexion, ou pour un backend que l'application ne sait pas énumérer (Ollama
hors ligne, par exemple : sa liste précédente est alors conservée). Vous pouvez
toujours compléter le repli local depuis `config_local.py` avec :

```python
EXTRA_LLAMA_MODELS = ("mon-modele-Q4_K_M.gguf",)
```

Le modèle sélectionné dans Lumen est également poussé vers l'écran, et
inversement : les deux affichages restent alignés dans les deux sens.

Les changements rapprochés sont regroupés pour protéger l'écran. Un plein
rafraîchissement est automatiquement effectué après 20 rafraîchissements
partiels.

## Dépannage

- **Écran blanc** : vérifier VCC, GND, CS, DC, RST et BUSY.
- **Écran rempli de bruit noir et blanc, malgré des clignotements** : la dalle
  rafraîchit bien, mais la RAM image n'est jamais écrite ; elle affiche donc
  son contenu non initialisé. C'est presque toujours la ligne **DC** qui ne
  bascule plus. Sur Pico W, le MISO par défaut de `SPI(1)` est **GP8**, la
  broche DC : si l'objet `Pin` de DC est créé avant `SPI()`, MicroPython
  confisque la broche et `DC` reste figé. `epd2in13_v4.py` construit donc le
  bus SPI **avant** les GPIO de contrôle ; ne pas remonter ces lignes.
  Recopier la version récente de `epd2in13_v4.py`, puis redémarrer la carte.
- **`BUSY timeout`** : BUSY est mal câblé, l'écran est mal alimenté ou ce n'est
  pas une révision V4 noir/blanc.
- **Image tête-bêche** : définir `EPD_ROTATION = 180`.
- **Encodeur inversé** : `ENCODER_REVERSED = True`.
- **Encodeur instable** : raccourcir les fils ou ajouter deux condensateurs
  de 10–100 nF entre A/GND et B/GND.
- **Boutons qui ne répondent qu'une fois sur deux** : les boutons et l'encodeur
  sont sur interruption précisément pour survivre aux rafraîchissements de
  l'écran, qui bloquent la boucle plusieurs centaines de millisecondes. Si la
  console affiche `interruptions INDISPONIBLES`, ce filet ne joue plus.
- **La molette ne parcourt qu'une partie des modèles et tourne en rond** : le
  contrôleur retrouve sa position par `catalogue.index(modele)`. Si
  l'application lui renvoie un nom qui n'y figure pas au caractère près (par
  exemple sans son suffixe `:latest`), il repart de zéro à chaque cran. Le
  firmware mémorise désormais la position, mais un nom exact reste préférable.
- **Écran qui semble redémarrer en tournant la molette** : c'est le
  rafraîchissement complet, qui fait clignoter toute dalle e-paper. Il est
  maintenant différé tant que les changements s'enchaînent. La console ne
  montre aucun redémarrage dans ce cas : c'est normal, la carte n'a pas
  redémarré.
- **Catalogue tronqué** : `catalogue … tronque a 32 entrees` sur la console. Le
  plafond protège la RAM du Pico W, qui lit la ligne JSON entière.
- **Gel, écran qui clignote, valeurs revenues aux défauts** : la carte a
  redémarré, très probablement sur un `MemoryError`. La console imprime
  `memoire libre au demarrage: …` puis `memoire faible: …` sous 24 Ko. En
  dessous de ~20 Ko libres, retirez du montage ce qui n'est pas utilisé
  (`LED_PIN = None`, `RFID_PIN_CS = None`) ou réduisez `LED_COUNT`.
- **Un bouton ne répond qu'une fois sur deux** : symptôme d'un anti-rebond qui
  jette le front final et laisse l'état interne bloqué sur « enfoncé ». Corrigé
  en faisant tourner la scrutation *en plus* des interruptions ; si vous
  modifiez `input.py`, gardez les deux chemins.
- **Contrôleur globalement lent** : vérifier `RFID_POLL_MS`. Une scrutation du
  lecteur sans carte attend l'expiration du timer du MFRC522 ; la faire à
  chaque tour de boucle suffit à rendre les boutons inutilisables.
- **Encodeur sans effet, broches inconnues** : lancer le diagnostic dédié
  (voir ci-dessous). Vérifier d'abord que le **commun** de l'encodeur (`C`, ou
  `GND` sur un KY-040) va bien à la masse de la carte : sans cela aucune
  broche ne bouge.
- **Un cran fait avancer de deux valeurs** : `ENCODER_STEPS_PER_DETENT = 2`.
  S'il en faut deux pour avancer d'une, mettre `8`.
- **`interruptions INDISPONIBLES` au démarrage** : le port MicroPython refuse
  `irq()` sur ces broches. Le décodage retombe sur la scrutation, très
  dégradée : déplacez l'encodeur sur deux GPIO ordinaires.
- **Volume instable** : raccourcir le fil du curseur et ajouter 100 nF entre le
  curseur et GND.
- **Volume inversé** : définir `VOLUME_REVERSED = True`.
- **Bouton toujours actif** : vérifier qu'il relie le GPIO à GND uniquement
  pendant l'appui.
- **Un bouton ne fait rien** : comparer sa broche à la ligne `Entrees:` imprimée
  au démarrage. Le firmware ne surveille que celles-là.
- **Appui long non détecté** : l'anti-rebond consomme les premières dizaines de
  millisecondes, tenez donc un peu au-delà de `BUTTON_LONG_MS`.
- **LEDs éteintes** : la console indique `LEDs desactivees: …` si `neopixel`
  manque ou si la broche est invalide. Un `LED_PIN = None` les désactive
  volontairement.
- **LEDs qui scintillent ou carte qui redémarre** : alimentation insuffisante.
  Baissez `LED_BRIGHTNESS`, réduisez `LED_COUNT`, ou alimentez le bandeau à
  part en 5 V avec une masse commune.
- **ESP32 bloqué au boot** : déplacer DC/CS hors GPIO2/GPIO15.
- **Pas de réseau** : vérifier SSID/mot de passe et utiliser un réseau 2,4 GHz.

### Diagnostic autonome de l'encodeur

Quand rien n'est sérigraphié sur l'encodeur, ce script identifie les broches
tout seul :

```sh
mpremote connect auto run encoder_test.py
```

Il scrute toutes les broches libres pendant que vous tournez, puis pendant que
vous appuyez, et déduit A, B et SW de ce qui bouge. Les broches déjà occupées
(écran, LEDs, boutons) ne sont jamais touchées. Il enchaîne sur un décodage en
direct, puis affiche les lignes exactes à recopier dans `config_local.py`.

En fonctionnement normal, `main.py` journalise aussi chaque cran :

```text
encodeur: A=2 B=3, 4 transitions/cran, interruptions actives
encodeur: +1 cran(s) sur model (16 transitions)
```

Des transitions qui montent sans qu'aucun cran ne sorte indiquent un mauvais
`ENCODER_STEPS_PER_DETENT`. Aucune transition du tout indique un problème de
câblage, en premier lieu le commun qui n'est pas à la masse.

### Diagnostic autonome de l'écran

Arrêtez `main.py` avec `Ctrl-C`, puis lancez depuis l'ordinateur :

```sh
mpremote connect auto run epaper_test.py
```

Le test se déroule en quatre étapes : `init`, écran tout noir, écran tout
blanc, puis image de test. Les étapes 2 et 3 n'utilisent aucun framebuffer :
si elles restent blanches, le problème est le dialogue SPI ou l'alimentation,
jamais le dessin. L'étape 2 imprime `BUSY s'est leve pendant le refresh:`. Si
la valeur est `False`, la dalle n'a jamais reçu la commande d'activation :
vérifiez CS, DC, CLK, DIN et `EPD_SPI_ID`. Si elle est `True` mais que rien
n'apparaît, le contrôleur travaille : suspectez alors l'alimentation VCC ou
une dalle qui n'est pas une V4 noir/blanc.

Le test affiche les GPIO employés et l'état initial de BUSY. Sur Pico W, la
ligne attendue commence par :

```text
e-paper v4: SPI(1) SCK=10 MOSI=11 CS=9 DC=8 RST=12 BUSY=13
```

Si la dalle porte explicitement une étiquette V4, le pilote V4 reste testable
avec `EPD_PANEL_DRIVER = "v4"` dans `config_local.py`.

Si le timeout indique `level=1 active=1`, BUSY reste actif : vérifiez en
priorité que BUSY va bien sur **GP13, broche physique 17**, RST sur **GP12,
broche 16**, VCC sur **VSYS, broche 39**, puis la masse
commune. Pour un module dont la documentation indique exceptionnellement BUSY
actif bas, testez `EPD_BUSY_ACTIVE = 0` dans `config_local.py`.

Sur un PCB marqué **Rev 2.1**, RST commande aussi la coupure d'alimentation.
Le firmware utilise donc une impulsion basse courte de 2 ms. Si BUSY passe de
0 à 1 après le reset et reste bloqué à l'étape `power-on`, essayez :

```python
EPD_RESET_LOW_US = 200
```

Ne changez pas `EPD_BUSY_ACTIVE` dans ce cas : un niveau initial à 0 suivi d'un
niveau à 1 pendant le reset correspond bien à BUSY actif haut.

Si la console affiche déjà `level=1` sur la première ligne, un rafraîchissement
précédent a laissé le contrôleur bloqué alors qu'un soft reboot n'a pas coupé
son alimentation. Le pilote tente désormais une récupération Rev 2.1
automatique. Pour repartir d'un état absolument propre, débranchez malgré tout
l'USB et VCC de l'écran pendant dix secondes, rebranchez VCC puis l'USB, et
évitez un simple `Ctrl-D`.
