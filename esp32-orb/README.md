# Avatar Lumen — ESP32-S3-LCD-1.28 (écran rond GC9A01, MicroPython)

Reproduction physique de l'orbe Lumen (halo qui respire, thèmes de couleur,
réaction à la voix) sur l'écran rond 240×240 GC9A01.

> **Important — driver.** Ce projet utilise le driver **C compilé `gc9a01`**
> (`import gc9a01`), le même que ton firmware voiture qui fonctionne
> (`Backup_ESPROUND`), **pas** le `gc9a01py` pur Python. Le module C est figé
> dans ton firmware ; garde-le. C'est ce qui expose `fill_circle` en natif.

## Approche

Le driver C dessine `fill_circle` très vite. L'orbe est donc rendu comme une
pile de **cercles concentriques** : bord sombre (halo) → cœur lumineux. Quelques
dizaines de cercles par frame passent large à 30 fps, **sans buffer géant ni
PSRAM**. La respiration module la luminosité (+ un léger rayon) ; en mode
`speaking`, c'est le niveau audio qui pilote l'éclat.

### Rendu optimisé de l'accueil

L'accueil utilise deux couches : la sphère, le liseré et la pastille réseau
sont transférés une seule fois dans un framebuffer statique ; l'aurore et les
yeux utilisent ensuite un framebuffer central de `148×148`. Le transfert SPI
par frame passe ainsi d'environ 107 Ko à 43 Ko. La couche statique est
automatiquement invalidée lors d'un retour depuis un menu, d'un changement de
thème ou d'un changement de connexion Lumen.

## Fichiers

| Fichier            | Rôle |
|--------------------|------|
| `config.py`        | Broches SPI, taille/anneaux de l'orbe, WiFi. Calé sur `tft_config.py`. |
| `themes.py`        | Palettes (bg → edge → mid → core). |
| `orb.py`           | Rendu par cercles concentriques (`fill_circle`). |
| `netstate.py`      | Réception TCP JSON non-bloquante (asyncio). |
| `main.py`          | Init écran + boucle de rendu + tâche réseau. |
| `test_display.py`  | Test écran minimal (à lancer en premier). |
| `sender_demo.py`   | **Sur PC** : pousse des états de test vers l'ESP32. |

## Câblage (identique à `Backup_ESPROUND/display/tft_config.py`)

```
SPI host 2 @ 80 MHz, polarity=0
SCK=10  MOSI=11  DC=8  CS=9  RST=14  BL=2
```

## Mise en route

1. **Le module C `gc9a01` doit être présent** (il l'est déjà, ton firmware
   voiture l'utilise). Ne flashe rien d'autre.
2. Configure `WIFI_SSID`, `WIFI_PASS` et éventuellement `NET_PORT` dans
   `config.py`.
3. Copie les fichiers du dossier sur la carte :
   ```bash
   cd esp32-orb
   mpremote connect /dev/cu.wchusbserial585A0103821 fs cp \
     config.py themes.py orb.py netstate.py main.py sensors.py cst816.py \
     tft_config.py backlight.py :
   mpremote connect /dev/cu.wchusbserial585A0103821 fs mkdir fonts
   mpremote connect /dev/cu.wchusbserial585A0103821 fs cp \
     fonts/__init__.py fonts/Inter16.py fonts/Inter24.py fonts/Inter32.py :fonts/
   ```
4. **Teste l'écran d'abord** (isole tout souci d'init) :
   ```bash
   mpremote connect /dev/tty.usbmodemXXXX run test_display.py
   ```
   Tu dois voir rouge → vert → bleu, puis deux cercles. Si oui, l'init est bonne.
5. Lance le firmware avec :
   ```bash
   mpremote connect /dev/cu.wchusbserial585A0103821 reset
   ```

## Configuration de Lumen

Dans les paramètres Lumen, renseigne une seule fois l'adresse affichée dans
`Réglages > Connexion` sur l'ESP32, port `8787`. L'adresse est mémorisée ; Lumen
se reconnecte automatiquement au démarrage. La pastille supérieure de l'orbe
est verte lorsque le socket Lumen est actif et grise sinon.

Les changements frontend se trouvent dans `src/orb-bridge.js`, `src/main.js`
et `src/sandbox/desktop.js`. Ils nécessitent un redémarrage du serveur de
développement ou une reconstruction de l'application installée. Copier le
firmware seul ne met pas à jour le pont inclus dans une ancienne build Lumen.

### « Rien ne s'affiche » — checklist

- `ImportError: no module named 'gc9a01'` → le module C n'est pas dans ce
  firmware. Reflashe le firmware qui contient `gc9a01` (celui de la voiture).
- Écran noir mais pas d'erreur → vérifie `SPI_ID=2`, `polarity=0`, et le
  rétroéclairage (`PIN_BL=2`). Ce sont les valeurs de ton `tft_config.py`.
- Rien avec `main.py` mais `test_display.py` marche → dis-le moi, c'est côté
  boucle asyncio.

## Piloter l'orbe depuis le réseau

Active le WiFi dans `config.py` (`WIFI_ENABLE=True`, SSID/mdp). L'ESP32 imprime
son IP et écoute en TCP sur `NET_PORT`. Envoie des **lignes JSON** :

```json
{"theme": "aurora", "mode": "speaking", "level": 0.7}
{"mode": "idle"}
```

- `theme` : `aurora | violet | ember | ocean | mono`.
- `mode`  : `idle` / `listening` (respiration) · `speaking` (éclat piloté par `level`).
- `level` : `0.0..1.0`, amplitude audio instantanée (pousse-la à ~30 Hz).

### Interface locale et événements Lumen

Sur l'accueil, un tap ouvre le menu. Chaque bouton ou ligne est directement
cliquable ; les swipes haut/bas/droite restent disponibles pour naviguer et le
swipe gauche revient en arrière. Un appui long active la veille. Le menu expose
`Réglages`, `Apps`, `Conversation`, `Écoute`, `Agent` et `Veille`.

Les réglages locaux sont `Luminosité`, `Connexion`, `Info` et `Thème`.
`Connexion` affiche l'état Wi-Fi, le SSID, l'adresse IP et la liaison Lumen.
`Info` affiche la version du firmware (`FIRMWARE_VERSION` dans `config.py`),
le stockage flash libre, la RAM libre, le MCU et l'écran. La secousse ne
déclenche aucune action.

L'IMU/gyroscope QMI8658 n'est pas initialisé et n'est jamais interrogé. Le
tactile CST816 reste pleinement actif en mode coordonnées + gestes. Le fichier
`qmi8658.py` n'est donc pas nécessaire sur la carte.

Messages entrants optionnels :

```json
{"notification":{"text":"Tâche terminée","source":"Heartbeat","success":true,"timestamp":"19:42","count":2}}
{"message":"Voici la dernière réponse de Lumen"}
{"connected":true}
```

Commandes ESP32 vers Lumen :

```json
{"cmd":"dictation"}
{"cmd":"conversation"}
{"cmd":"open_app", "app":"calendar"}
{"cmd":"sleep"}
{"cmd":"wake"}
```

`open_app` est traité directement par `src-tauri/src/orb_bridge.rs` : le backend
valide l'identifiant dans une liste blanche puis crée ou ramène au premier plan
la fenêtre Tauri correspondante. Il ne dépend donc pas de la webview active ni
du cache JavaScript. Les identifiants actuels sont `agents`, `designer`,
`calendar`, `notes`, `domotique`, `games`.
`conversation` demande à Lumen de renvoyer la dernière réponse assistant.
Chaque nouvelle réponse et chaque notification Heartbeat sont également
poussées automatiquement vers l'ESP32.

Les écrans Conversation et Notification acceptent jusqu'à 700 caractères.
Un swipe vers le haut avance par page et un swipe vers le bas remonte. Deux
lignes sont conservées entre les pages pour préserver le contexte : 4 nouvelles
lignes sur 6 dans Conversation, 3 sur 5 dans Notification. Le compteur en bas
indique la page et le swipe gauche revient au menu précédent.

### Diagnostic du pont

- Dictée OK mais Apps KO : la build Lumen est ancienne ; `open_app` nécessite
  une reconstruction incluant `src-tauri/src/orb_bridge.rs` et `lib.rs`.
- Pastille verte mais aucun état reçu : vérifier que Lumen utilise la même IP
  et le port `8787`.
- Apps reçues mais bureau fermé : Lumen ouvre l'app dans la webview du bureau ;
  le routage utilise l'événement global `lumen-orb-open-app`.
- Aucune notification : vérifier que la notification passe par
  `addNotification()` ; celle-ci appelle `OrbBridge.pushNotification()`.
- Aucun message : les réponses assistant appellent `pushOrbMessage()` après
  leur ajout à l'historique.

### Zones tactiles et assets de l'interface

Le tactile fonctionne en coordonnées écran `240×240` (origine en haut à
gauche). Les six boutons du menu ont un rayon tactile de 31 px et sont centrés
sur : `(120,48)`, `(178,76)`, `(178,148)`, `(120,180)`, `(62,148)`,
`(62,76)`. Notifications occupe le bouton central `(120,120)`. Toutes les
bulles ont un rayon visuel de 24 px et un rayon tactile de 31 px. Le retour se
fait par swipe gauche.
Les listes utilisent quatre lignes tactiles de 184×30 px, de `x=28` à `212`,
centrées à `y=69,99,129,159`.

Les JPEG dans `img/` servent de sources et d'aperçus. Le menu ne les affiche
plus directement : le format JPEG n'a pas de transparence et ses coins créaient
des fonds noirs visibles dans les bulles. `tools/make_icon_masks.py` les
convertit en masques monochromes dans `icon_masks.py`. Le firmware dessine ces
masques directement dans son framebuffer, sans aucun fond.

| Dossier | Taille | Fichiers attendus |
|---|---:|---|
| `img/menu/` | 32×32 | `settings.jpg`, `apps.jpg`, `conversation.jpg`, `dictation.jpg`, `agent.jpg`, `sleep.jpg`, `notifications.jpg` |
| `img/apps/` | 24×24 | `agents.jpg`, `designer.jpg`, `calendar.jpg`, `notes.jpg`, `domotique.jpg`, `games.jpg` |

Comme le JPEG ne gère pas la transparence, utiliser un fond sombre `#10131d`
autour du pictogramme. Le placement est calculé par le firmware ; les images
ne doivent contenir ni marge supplémentaire ni texte.

Pour installer les icônes sur l'ESP32, un seul fichier est désormais requis :

```bash
mpremote connect /dev/cu.wchusbserial585A0103821 fs cp icon_masks.py :
mpremote connect /dev/cu.wchusbserial585A0103821 reset
```

Les sources vectorielles sont définies dans `tools/export_icons.py`. Le script
utilise Sharp via `tools/rasterize_svg.cjs`, rend en haute résolution puis
réduit à la taille cible avant l'encodage JPEG 4:4:4. Cela évite les contours
illisibles sur 24 ou 32 pixels. Après modification des sources, régénérer
`icon_masks.py` avec `tools/make_icon_masks.py`.

Test depuis le PC : `python3 sender_demo.py <ip_esp32> 8787`.

## Pont Lumen OS → orbe physique

Côté web, l'apparence passe par `LumenOrb.applyAppearance(payload)`
(`src/orb.js`, thème dupliqué avec `main.js`). Mappe ce payload vers le JSON
ci-dessus : `payload.orbTheme` → `theme` ; début TTS → `{"mode":"speaking"}` +
`level` depuis l'`AnalyserNode` (le même signal qui anime l'orbe web) ; fin →
`{"mode":"idle"}` ; micro actif → `{"mode":"listening"}`.

⚠️ Les couleurs de `themes.py` sont une **3e copie** (après `orb.js` et
`main.js`) : garde-les synchronisées.

## Réglages

- **Dégradé plus fin** : monte `RINGS` (28 → 40). C'est du C, ça reste fluide.
- **Respiration** : `BREATHE_PERIOD_MS`, `BREATHE_MIN`.
- **Reflet / cœur** : voir `orb.render()` (position `hx,hy`, rayon `R//5`).
- **Taille** : `MARGIN` (marge au bord de l'écran).
