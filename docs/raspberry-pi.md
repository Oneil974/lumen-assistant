# Lumen Pi — export Raspberry Pi

Un build dédié au Raspberry Pi qui :

- **désactive Apple Intelligence** (sélecteur de source masqué, source **Ollama**
  forcée, onboarding sur son parcours Ollama) ;
- ajoute une catégorie de blocs Fluxo **« Raspberry Pi »** (GPIO, PWM, servo, I²C,
  série, infos système).

Tout est activé par la **feature Cargo `rpi`**. Sans elle, le build standard
(macOS) est inchangé : aucun bloc Pi, aucune dépendance matérielle.

## IA déportée (Ollama + Bonsai sur une autre machine)

Le Pi n'a pas la puissance pour l'inférence : **Ollama** (LLM) et **Bonsai**
(génération d'images, MLX = Apple uniquement) tournent sur une **machine
distante** du réseau local. Côté Pi, tout est piloté par URL :

- **Ollama** — Réglages → champ *URL Ollama* (ex. `http://192.168.1.20:11434`).
  Sur la machine hôte, lancer Ollama avec `OLLAMA_HOST=0.0.0.0` pour qu'il
  accepte les connexions du réseau. L'URL est persistée et repoussée au backend.
- **Bonsai** — Réglages → *URL du backend Bonsai* (ex. `http://192.168.1.20:8800`).
  Les boutons « Télécharger / Lancer l'API » locale sont **masqués** sur le Pi
  (MLX indisponible) ; seul le champ URL distante est utilisé. L'URL est persistée
  et réappliquée au démarrage.

La **sandbox**, l'éditeur de documents/présentations, le Kanban, le moteur Fluxo,
les agents et la synthèse vocale s'exécutent **localement** sur le Pi (Rust std +
système de fichiers, sans dépendance Apple).

## Approche matérielle (option B : pigpiod)

Les blocs GPIO/PWM/I²C/série n'embarquent **aucune bibliothèque native**. Ils
appellent `pigs`, le client en ligne de commande du démon **pigpiod**. Avantages :
moteur portable (compile partout), pas d'état de broche à gérer côté app, et
remplaçable plus tard par une implémentation maison (ex. Python) en réécrivant la
couche `pigs` côté système.

Le démon doit tourner :

```sh
sudo apt install -y pigpio
sudo systemctl enable --now pigpiod
```

Les blocs « infos » lisent `/proc`, `/sys` et `df` (température, mémoire, disque,
charge, uptime, modèle).

### Raspberry Pi 5 : pigpio-lite (lgpio)

Sur le **Pi 5**, pigpiod ne fonctionne pas (southbridge RP1). Utilise le remplaçant
fourni `scripts/pigpio-lite/` (démon Python sur **lgpio** + shim `pigs` compatible) :

```sh
cd scripts/pigpio-lite && sudo ./install.sh
```

Les blocs GPIO/PWM/I²C/SPI fonctionnent alors sans changement. Détails :
[`scripts/pigpio-lite/README.md`](../scripts/pigpio-lite/README.md).

## Construire

Sur le Pi (Raspberry Pi OS 64-bit), **sans sudo** :

```sh
# Prérequis, une fois : deps système + Rust (rustup) + Node ≥ 18 (NodeSource).
# Le script demande sudo lui-même quand il en a besoin — ne le préfixe PAS de sudo.
./scripts/install-prereqs-pi.sh

# Build (rouvrir le terminal avant, pour avoir cargo dans le PATH).
./scripts/build-pi.sh
# Sur 4 Go de RAM, limite le parallélisme : CARGO_BUILD_JOBS=2 ./scripts/build-pi.sh
```

> Ne lance jamais `build-pi.sh` ni `npm` en `sudo` : ça crée des fichiers root
> dans `node_modules/` et casse les builds suivants (erreurs `EACCES`). Le script
> détecte et nettoie ce cas automatiquement, mais autant l'éviter. Seuls les
> `install*.sh` (prérequis, Piper, Kokoro) utilisent sudo.

Bundles produits dans `src-tauri/target/release/bundle/` (`.deb`, AppImage).

### AppImage uniquement

```sh
npm run tauri build -- --features rpi --bundles appimage
```

→ `src-tauri/target/release/bundle/appimage/*.AppImage` (rendre exécutable :
`chmod +x *.AppImage`). Pour un `.deb` seul : `--bundles deb`.

> La compilation croisée depuis macOS (Tauri + WebKitGTK) est impraticable : on
> compile **nativement sur l'appareil**.

## Déployer en plein écran (écran principal ou borne)

`scripts/deploy-pi.sh` installe l'application et la fait démarrer directement
sur le **bureau de Lumen, plein écran**, à l'ouverture de session — sur un
Raspberry Pi comme sur un Linux Debian/Ubuntu ordinaire.

```bash
# Pi de bureau : compile sur place (feature rpi), installe le .deb, pose l'autostart
./scripts/deploy-pi.sh --build

# Paquet déjà construit, avec le service GPIO (pigpiod, ou pigpio-lite sur Pi 5)
./scripts/deploy-pi.sh --deb ~/Lumen_0.2.0_arm64.deb --gpio

# Borne verrouillée (aucun bureau, cage + greetd, relance automatique) — Pi OS Lite compris
sudo ./scripts/deploy-pi.sh --appimage ~/Lumen.AppImage --kiosk --user borne

# Revenir en arrière
./scripts/deploy-pi.sh --uninstall
```

Deux modes :

- **bureau conservé** (défaut) : une entrée `~/.config/autostart/lumen-fullscreen.desktop`
  lance `LUMEN_KIOSK=1 lumen` ; le bureau de Lumen s'ouvre plein écran par-dessus
  la session. F11 (ou le bouton « Plein écran » de la barre des tâches) en sort.
  Sous X11 le script pose aussi `picom` en autostart (sans compositeur la fenêtre
  transparente serait noire) ; sur un Pi il désactive l'extinction d'écran.
  `--hide-cursor` masque le pointeur au repos (écran tactile).
- **`--kiosk`** : délègue à `scripts/kiosk/install-kiosk.sh` — utilisateur dédié
  sans privilèges, compositeur `cage` qui n'affiche qu'une fenêtre, connexion
  automatique `greetd`, boucle de relance. C'est un kiosque logiciel : BIOS,
  démarrage USB et consoles virtuelles restent à verrouiller côté matériel.

## IA locale par LiteRT-LM (Google AI Edge)

Le build Pi peut embarquer **LiteRT-LM**, le moteur d'inférence embarqué de
Google, en plus du llama.cpp intégré. Sur un Raspberry Pi 5, Gemma 4 E2B y tourne
à environ **8 jetons par seconde** en génération pour ~1,4 Go de mémoire au pic
(Google annonce 9 tok/s dans son billet de blog et 7,6 sur la fiche du modèle —
mesure la tienne). C'est confortable en conversation, lent dès qu'un agent
enchaîne les tours.

### Construire le runtime

LiteRT-LM ne se distribue pas en binaire autonome : c'est un CLI Python posé sur
une roue native (`litert-lm-api`, publiée en `manylinux_2_27_aarch64`). Le script
en fabrique un venv complet, copié tel quel dans le bundle.

```sh
./scripts/build-litert-runtime.sh   # AVANT build-pi.sh
./scripts/build-pi.sh
```

Le venv doit être construit **sur l'architecture cible** : il contient du code
natif. `build-pi.sh` détecte sa présence et l'embarque ; s'il manque, le bundle
sort sans lui et la source correspondante n'apparaît simplement pas dans les
Réglages. La version de `litert-lm` est épinglée dans `config/litert-lm.version`
(surchargeable par `LITERT_LM_VERSION`).

Un venv grave son chemin absolu de construction dans le shebang de chaque
console script. Après empaquetage ce chemin n'existe plus, donc Lumen n'appelle
jamais `litert-lm` directement : il lance `venv/bin/python venv/bin/litert-lm`,
qui ignore le shebang.

### À l'exécution

Réglages → Source d'IA → « Local, LiteRT-LM (Google AI Edge) ». Le catalogue
propose Gemma 4 E2B (≈ 2,4 Go) et E4B (≈ 3,4 Go, à réserver aux cartes 16 Go),
téléchargés depuis Hugging Face avec la même barre de progression, la même
reprise et la même annulation que les GGUF.

Deux étapes séparent le fichier téléchargé d'un modèle utilisable, et Lumen les
enchaîne au premier message :

1. **import** — `serve` n'expose que les modèles présents dans le registre du
   CLI ; un fichier simplement téléchargé remonte en « model not found ». Lumen
   appelle donc `litert-lm import` une fois par modèle et par session ;
2. **serve** — un seul processus couvre toute la session : le serveur ne se voit
   pas imposer de modèle au lancement, chaque requête nomme le sien.

Le serveur écoute sur `127.0.0.1:9379` — et non sur le `0.0.0.0` par défaut du
CLI, qui l'exposerait à tout le réseau local. Il parle l'API OpenAI, donc le
routeur LLM de Lumen s'y branche comme sur llama-server. Le registre et la config
du CLI vivent dans `~/.litert-lm`, inspectables avec les commandes documentées
par Google (`list`, `delete`, `rename`).

### Limites connues

- **Deux endpoints seulement** : `/v1/models` et `/v1/chat/completions`. Le RAG
  continue donc de passer par le serveur d'embeddings llama.cpp (port 11436).
- **Le serveur est mono-thread** : une requête lente bloque les autres
  ([LiteRT-LM #1993](https://github.com/google-ai-edge/LiteRT-LM/issues/1993)).
  Lumen émet des appels concurrents (barre, agents, blocs Fluxo) — ça se voit.
- **Le tool calling n'est pas garanti** par cette route. Le framework l'annonce
  et Lumen transmet bien `tools`, mais la documentation du serveur OpenAI ne le
  spécifie pas. À vérifier sur la machine avec `scripts/probe-tool-calling.mjs`
  avant de compter dessus pour les agents.
- **Pas de métriques de vitesse** : LiteRT-LM ne renvoie pas les `timings` de
  llama.cpp. Le Profiler affiche les jetons, pas les tokens/seconde.

## Blocs Raspberry Pi disponibles

| Bloc | Rôle |
|------|------|
| GPIO : mode | broche en entrée/sortie |
| GPIO : écrire | met une broche à l'état haut/bas |
| GPIO : lire | lit l'état d'une broche (0/1) |
| GPIO : résistance interne | pull-up / pull-down / aucun |
| PWM | rapport cyclique 0–255 |
| PWM : fréquence | fréquence PWM (Hz) |
| Servo | largeur d'impulsion 500–2500 µs (0 = arrêt) |
| I²C : écrire un octet | écrit un registre (bus/adresse/registre/valeur, hex ou déc) |
| I²C : lire un octet | lit un registre |
| Série : écrire | envoie du texte sur l'UART (device/baud) |
| Série : lire | lit l'UART avec délai d'attente |
| SPI : transfert | échange duplex d'octets (canal/baud), renvoie les octets lus (hex) |
| 1-Wire : périphériques | liste les identifiants 1-Wire détectés |
| 1-Wire : température (DS18B20) | température °C d'un capteur DS18B20 |
| Pi : température CPU | °C du SoC |
| Pi : mémoire | total/utilisé/libre (Mo) + % |
| Pi : espace disque | d'un point de montage |
| Pi : charge CPU | load average 1/5/15 min |
| Pi : temps de fonctionnement | uptime (s) |
| Pi : informations | résumé (modèle, hôte, temp, mém, disque, charge, uptime) |

## Synthèse vocale (chat + bloc Fluxo)

Sur le build Pi, l'énonciation du chat passe par un TTS neuronal local au lieu
d'Apple. Deux moteurs au choix, dans le même catalogue des réglages :

- **Piper** (MIT, léger, voix `.onnx` par langue) :
  ```sh
  cd scripts/piper && sudo ./install.sh   # binaire piper + alsa-utils
  ```
- **Kokoro** (Apache 2.0, qualité supérieure, ONNX/CPU, FR + EN) :
  ```sh
  cd scripts/kokoro && sudo ./install.sh  # venv /opt/kokoro-venv + espeak-ng + alsa-utils
  ```

Puis dans **Lumen → Réglages → Synthèse vocale** : télécharger une voix au choix.
Le catalogue mélange les voix **Piper** et **Kokoro** (`Siwis FR`, `Heart`/`Michael`
EN-US, `Emma`/`George` EN-GB) ; télécharger une voix Kokoro récupère une fois le
modèle partagé (~340 Mo). Sélectionner la **voix active**, « Tester la voix » :
l'énonciation du chat et l'auto-énonciation l'utilisent automatiquement.

Bloc Fluxo **« Synthèse vocale »** (catégorie Raspberry Pi) : énonce un texte
(voix active ou précisée) via le pont Lumen `/tts` — fonctionne avec Piper comme
Kokoro selon la voix active.

> **Kokoro** : le moteur s'exécute dans un venv dédié (`/opt/kokoro-venv`, détecté
> automatiquement par Lumen) ; la langue est déduite du préfixe de la voix
> (`ff_` → français, `b*_` → anglais GB, sinon anglais US). Modèle + embeddings :
> [`thewh1teagle/kokoro-onnx`](https://github.com/thewh1teagle/kokoro-onnx) (release `model-files-v1.0`).

> Les licences des voix proviennent du catalogue officiel
> [`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices) (fichier
> VOICES.md) ; la plupart sont en CC BY 4.0 (attribution requise). Vérifie selon ton usage.

### Interfaces à activer (`sudo raspi-config` → Interface Options, ou `/boot/config.txt`)

- **SPI** : `dtparam=spi=on` (utilise pigpiod, comme GPIO/PWM).
- **1-Wire** : `dtoverlay=w1-gpio` (par défaut sur GPIO4). Les capteurs apparaissent
  sous `/sys/bus/w1/devices/` (DS18B20 = `28-*`). N'utilise PAS pigpiod (lecture sysfs).
- **I²C** : `dtparam=i2c_arm=on`. **Série** : `enable_uart=1`.

Les broches sont en numérotation **BCM**. Les blocs « infos » renvoient un
dictionnaire (utilisable tel quel dans un widget Lumen ou via `{{var}}`).


## Boîtiers imprimables — finitions Or et Rouge

`hardware/pi-case/` contient un boîtier paramétrique OpenSCAD pour Pi 4 B et
Pi 5, dans la grammaire de l'habillage Lumen Pro : **coque noire, métal en
soulignement**. La couleur tient dans une plaque d'insert encastrée sur le
couvercle, gravée « LUMEN » — coque et couvercle sont identiques d'une finition
à l'autre.

```sh
cd hardware/pi-case && ./export-stl.sh        # Pi 5
BOARD=pi4 ./export-stl.sh                     # Pi 4 B
```

Trois pièces, deux filaments, aucune imprimante multi-matière nécessaire.
PETG ou ASA (le PLA flue à la température d'un Pi sous charge), aucun support.

La géométrie **n'a pas été rendue** faute d'OpenSCAD sur la machine de
développement : imprimez d'abord la coque seule et présentez-y la carte avant de
lancer le jeu complet. Détails et cotes : `hardware/pi-case/README.md`.
