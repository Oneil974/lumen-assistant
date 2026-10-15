# Lumen Controller — MicroPython

Firmware de référence pour un panneau avec un encodeur rotatif, un
potentiomètre de volume, quatre boutons et un écran. Le profil par défaut cible
le **Waveshare 2.13inch e-Paper HAT V4 noir/blanc 250×122**. Le SSD1306 reste
disponible en option.

Il fonctionne sur ESP32 et Pico W (Wi‑Fi), et pilote Lumen sur le réseau local
en TCP JSON ligne par ligne, port `8787`.

Un Raspberry Pi Pico **sans suffixe W** n'a pas de Wi‑Fi : utilisez un Pico W
ou ajoutez un module réseau externe.

## Fonctions

| Commande | Action |
|---|---|
| **Backend**, appui court | Ollama → llama.cpp/llama-server → Apple → API |
| **Backend**, appui long (~0,7 s) | charge le modèle affiché en mémoire (`Loading` à l'écran) |
| **Mic**, appui court | dictée, puis **envoi du message** sans passer par le clavier |
| **Mic**, appui long (~0,7 s) | nouvelle conversation (comme « Nettoyer la discussion ») |
| **Mode** | mode de discussion : Chat → Router → Tools → Docs |
| **Poussoir de l'encodeur**, appui court | change ce sur quoi agit la molette : modèle → voix → LED |
| **Poussoir de l'encodeur**, appui long | **tout arrêter** : lecture vocale, génération, workflow |
| **Molette** | valeur suivante/précédente de la fonction sélectionnée |
| **Potentiomètre** | envoie `hid_volume` au bridge Lumen Desktop |
| **Badge RFID** | déclenche l'action associée au badge dans Lumen |

L'écran affiche le backend, le volume, l'état de Lumen, le **badge de la voix**
de synthèse active, le **badge du mode de discussion** juste en dessous, le
**débit de la dernière réponse** en tokens/s, et l'**occupation du contexte**
sous la forme `CTX 2.5k/8k`.

Les jetons sont divisés par 1024, pas par 1000 : une fenêtre de contexte est
toujours une puissance de deux, et 8192 doit se lire « 8k » et non « 8.2k ».
Au-delà de 10k la décimale est abandonnée (`CTX 117k/128k`), la ligne ne
faisant que treize caractères.

Un petit **cadran** suivi de `MODELE`, `VOIX` ou `LED` occupe la rangée étroite
coincée entre l'icône et le badge backend : il dit ce que la molette pilote,
là où l'ancienne abréviation `ENC` ne parlait qu'à qui avait écrit le firmware.
La **valeur** pilotée par la molette est sur la rangée du dessous,
qui court sur toute la largeur — 21 caractères, contre 12 auparavant. Un nom
trop long est élidé par le **milieu** (`LFM2.5-1.2B-T..Q4_K_M`) : un GGUF porte
son nombre de paramètres au début et sa quantification à la fin, couper la fin
faisait perdre l'un ou l'autre. Tant que Lumen n'est pas relié, la ligne d'état montre
l'**adresse IP** à saisir dans Réglages, ce qui évite la console série.

### Veille de la dalle

Après une minute sans changement (`EPD_SLEEP_AFTER_MS`), la dalle est mise en
**sommeil profond**. Waveshare est explicite sur ce point : laisser un e-paper
sous tension en permanence le maintient en haute tension et l'abîme de façon
irréversible. C'est le seul levier qui joue réellement sur sa durée de vie.

**L'image n'est pas effacée** : un e-paper la conserve sans alimentation. Elle
reste donc lisible pendant la veille, et l'effacer coûterait un
rafraîchissement de plus — or c'est leur *nombre* qui use la dalle, pas la
durée d'affichage.

Aucun réveil manuel n'est nécessaire : le contrôleur, lui, ne dort jamais. Les
boutons, la molette et le lecteur RFID répondent normalement ; c'est le premier
changement à afficher qui réveille la dalle, avec un rafraîchissement complet
(le sommeil profond perd le contenu des RAM du contrôleur d'écran).

Il n'y a pas d'indicateur de batterie : le contrôleur est alimenté en USB. La
liaison avec Lumen est signalée par la pastille en bas à droite, pleine quand
l'application est connectée.

### LEDs WS2812B

Un bandeau donne l'état de Lumen instantanément, là où l'e-paper met plusieurs
centaines de millisecondes à se redessiner :

| État | Couleur | Animation |
|---|---|---|
| repos | couleur choisie à la molette | respiration lente |
| écoute | bleu | pulsation |
| réflexion | ambre | pulsation |
| réponse | vert d'eau | pulsation |
| chargement | violet | pulsation |
| erreur | rouge | fixe |

Les couleurs d'état ne sont pas configurables : ce sont des significations, pas
une décoration. Seule la couleur de **repos** se choisit à la molette (fonction
`LED`). Sans le module `neopixel` ou avec `LED_PIN = None`, tout le reste
fonctionne normalement.

### Notifications lumineuses

À l'arrivée d'une notification, le bandeau joue un **pulse rapide** pendant
`NOTIFY_MS` (4 s par défaut), puis rend la main à la couleur d'état. Le pulse
descend presque à l'extinction, là où les états respirent entre 25 % et 100 % :
c'est ce qui le distingue au premier coup d'œil.

La couleur se choisit dans **Paramètres → Notifications → Notifications
lumineuses** et voyage avec chaque notification (`notification.color`). C'est
la seule couleur *décorative* imposée par l'application ; sans elle, le
firmware utilise `NOTIFY_COLOR` de `config.py`.

Le microcontrôleur ne peut pas simuler un clavier USB HID tout en utilisant le
Wi‑Fi dans toutes les builds MicroPython. `hid_volume` est donc une commande
réseau : Lumen la reçoit et applique le volume de sortie du système via la
commande Rust `system_set_volume` (`osascript` sur macOS, Core Audio par
PowerShell sur Windows, `pactl` puis `amixer` sur Linux).

Le potentiomètre donne une position **absolue** : le volume est réglé à une
valeur, pas incrémenté. Les positions intermédiaires reçues pendant qu'un
réglage est en cours sont fusionnées — seule la dernière est appliquée, ce qui
évite de lancer un processus par cran.

## Installation

1. Vérifier que l'écran porte la mention **V4** et qu'il s'agit de la variante
   noir/blanc, pas des variantes `(B)` ou `(G)`.
2. Flasher MicroPython (ESP32 ou Pico W), copier `*.py` sur la carte.
3. Créer `config_local.py` (ou modifier `config.py`) avec SSID/mot de passe et
   les GPIO de votre carte.
4. Redémarrer : l'écran fait un rafraîchissement complet, puis affiche
   l'adresse IP à saisir dans Réglages (elle est aussi imprimée sur la
   console série).

Le câblage, les profils complets ESP32/Pico W et le dépannage sont dans
[WAVESHARE-2IN13.md](WAVESHARE-2IN13.md).

Pour revenir au SSD1306, définir `DISPLAY_TYPE = "ssd1306"` et installer
`ssd1306.py` depuis le bundle MicroPython.

## Protocole

### Deux appareils, deux adresses

L'orbe ESP32 et le Lumen Controller parlent le même protocole sur le même port,
mais ce sont deux machines distinctes. Elles ont donc chacune leur adresse dans
Réglages, et **fonctionnent en même temps** :

| Appareil | Clé | Reçoit |
|---|---|---|
| Orbe ESP32 | `orbBridgeHost` | thème, niveau audio, notifications, WAV |
| Lumen Controller | `controllerHost` | état, catalogue, débit en tokens/s, notifications |

L'état de Lumen (`mode`/`status`) part vers **les deux** : chacun l'affiche à sa
façon. Chaque lien se reconnecte indépendamment ; l'un éteint n'empêche pas
l'autre de fonctionner. Les messages entrants portent un champ `device` qui
indique le champ de configuration d'où ils viennent.

Le champ utilisé ne détermine pourtant **pas** le traitement : seul le
contrôleur émet un `hello`, et c'est ce message qui l'identifie. Un contrôleur
saisi dans le champ « orbe » — cas fréquent, il n'y avait qu'une adresse
auparavant — reçoit donc quand même l'état et le catalogue, et se voit épargner
l'audio qu'il ne sait pas lire. La console le signale :

```text
[OrbBridge] un Lumen Controller répond sur le champ « orb » : il est traité comme tel.
```

Le **contrôleur est le serveur TCP** (port `8787`), l'application est le client.
C'est l'inverse de l'intuition, mais c'est ce qui permet à Lumen de se
reconnecter tout seul après un reboot de la carte : `orb-bridge.js` retente
toutes les 4 s tant que `orbBridgeHost` est défini.

Le transport est du **JSON, une ligne par message, séparateur `\n`**, dans les
deux sens. Aucun accusé de réception, aucune numérotation : chaque message
transporte un état complet ou une action ponctuelle.

### Contrôleur → application

Un seul type d'action, émis quand l'utilisateur touche une commande physique :

```json
{"type":"command","cmd":"dictation"}
{"type":"command","cmd":"set_model","model":"phi4","backend":"ollama"}
{"type":"command","cmd":"hid_volume","value":42,"delta":3}
{"type":"command","cmd":"set_mode","mode":"tools"}
{"type":"command","cmd":"set_voice","voice":"fr_FR-siwis-medium"}
{"type":"command","cmd":"load_model","model":"phi4","backend":"ollama"}
{"type":"command","cmd":"new_chat"}
{"type":"command","cmd":"stop"}
{"type":"command","cmd":"rfid","uid":"04A2B3C4"}
{"type":"command","cmd":"rfid_removed"}
```

Côté Rust, `orb_bridge.rs` réémet **chaque ligne reçue** vers le frontend dans
l'événement Tauri `orb-command`. `orb-bridge.js` ne regarde que le champ `cmd`
et le traduit en événement DOM `lumen-controller-*`, ou en clic sur
`#btn-dictation`.

Le contrôleur diffuse aussi un `{"type":"controller_state", ...}` toutes les
2 s. L'application l'ignore volontairement : elle fait autorité sur l'état,
et le consommer créerait une boucle de rétroaction.

### Application → contrôleur

```json
{"type":"state","backend":"ollama","model":"phi4","chat_mode":"tools","voice":"fr_FR-siwis-medium"}
{"type":"state","ctx_used":2560,"ctx_total":8192,"tps":15.7}
{"type":"state","rfid_pairing":true}
{"type":"catalog","models":{"ollama":["phi4","qwen3:8b"]},"voices":["fr_FR-siwis-medium"]}
{"mode":"listening","status":"thinking"}
{"heartbeat":1721990000000}
```

`Link.apply()` ne retient que les clés qu'il connaît (`backend`, `model`,
`status`, `mode`, `chat_mode`, `voice`, `volume`, `desktop`, `paused`,
`rfid_pairing`, `notification`) ; tout le
reste — `theme`, `level`, `heartbeat` — traverse sans effet.

`notification` déclenche le pulse coloré du bandeau :

```json
{"notification":{"text":"Sauvegarde terminée","source":"Fluxo","color":"#ff9f0a","count":1}}
```

Le `hello` du contrôleur annonce `protocol: 2` et ses capacités
(`chat_mode`, `voice`, `leds`, `notify_leds`…). L'application s'en sert notamment pour ne PAS
lui envoyer de flux audio brut, qu'il ne sait pas lire.

`mode` est le vocabulaire à trois états de l'orbe ESP32 (`idle`, `listening`,
`speaking`), qui écrase notamment `thinking` en `listening`. `status` porte
l'état **brut** de l'application (`thinking`, `loading`, `speaking`…) et a la
priorité : sans lui, l'écran affichait « Listening » pendant la réflexion.

Les messages **sans champ `type`** sont acceptés : c'est la forme historique de
l'orbe ESP32, que `pushMode()` et `pushTheme()` utilisent toujours.

### Badges RFID

Le contrôleur n'envoie que l'**UID** du badge. Il ignore totalement ce à quoi
il correspond, et c'est le point important de la conception : la table des
associations vit dans Lumen, ce qui permet d'ajouter de nouvelles actions
**sans jamais reflasher la carte**.

#### Un badge posé, un seul envoi

Le lecteur suit la **présence** du badge, pas seulement son passage : un badge
peut rester posé sur le lecteur sans que son action se rejoue en boucle. Seules
les transitions sont transmises :

| Sur le lecteur | Envoyé |
| --- | --- |
| rien → badge X | `{"cmd":"rfid","uid":"…"}` |
| badge X → rien | `{"cmd":"rfid_removed"}` |
| badge X → badge Y (échange à chaud) | `{"cmd":"rfid","uid":"…"}` pour Y |

Retirer puis reposer le même badge rejoue donc son action : c'est le geste
naturel, et c'est à cela que sert la détection du retrait. L'absence n'est
déclarée qu'après `RFID_ABSENT_POLLS` scrutations vides d'affilée (3 par
défaut) : une carte posée n'est pas vue à tous les tours, et un seul raté
suffirait sinon à faire clignoter la présence.

La scrutation utilise **WUPA** (`0x52`) et non REQA : une carte déjà lue reste
dans le champ mais ne répond plus à REQA, et le badge posé passerait pour
retiré au tour suivant.

**Exception : l'association.** Un écran des Réglages qui attend un badge ne
verrait jamais celui qui est *déjà* posé, puisqu'il ne provoque plus aucune
transition. Lumen arme donc `{"type":"state","rfid_pairing":true}` le temps de
la détection, et le contrôleur réémet l'UID présent toutes les
`RFID_REPEAT_MS`. Il le désarme dès que la détection s'arrête.

#### Déclencher un workflow Fluxo

Un badge peut aussi lancer une **automatisation Fluxo**, sans passer par la
table des associations : dans le designer, choisir le déclencheur « Badge RFID
(Lumen Controller) ». Le champ UID est facultatif — vide, n'importe quel badge
déclenche le workflow. Dans tous les cas **l'UID lu devient l'entrée du
workflow** (`{{input}}`), ce qui permet à un workflow unique d'aiguiller
lui-même selon le badge, ou de lancer un agent avec le badge en paramètre.

Le lancement se fait dans le pont TCP côté Rust (`orb_bridge.rs` →
`dispatch_rfid_triggers`), donc **sans dépendre d'une fenêtre ouverte**.

Le bloc **« Badge RFID »** (catégorie Lumen) lit le lecteur au milieu d'un
workflow — utile pour « pose ton badge pour valider » : avec un délai
d'attente, l'étape attend qu'un badge soit posé. Il renvoie l'UID, le libellé
du badge s'il est associé, ou l'objet complet.

#### Un badge, un seul usage

Un badge d'**ouverture de session** ne peut pas aussi porter une **action**, et
réciproquement — la règle est appliquée côté Rust, aux deux entrées
(`rfid_bind` et `session_set_rfid`, qui se refusent mutuellement l'UID). Sans
cela, poser son badge de session pendant une session ouverte changerait aussi
de modèle, et le geste « ouvrir ma session » deviendrait imprévisible.

La même règle vaut pour Fluxo : un badge de session ne déclenche **aucun**
workflow et n'apparaît jamais dans `/rfid/last` — il est écarté dès la lecture
par `rfid_store::record_badge`.

#### Où vit la table des associations

Elle est stockée **côté backend** (`src-tauri/src/rfid_store.rs`), au même
titre que la clé API : fichier `rfid_bindings.json` en 0600 dans le dossier de
données, et l'UID n'est **jamais** renvoyé à une webview. L'interface ne reçoit
qu'une forme masquée (`••••B3C4`) et un identifiant opaque pour supprimer une
entrée ; la résolution badge → action se fait entièrement en Rust.

Le registre est dans [`src/lib/rfid-bindings.js`](../src/lib/rfid-bindings.js).
Pour qu'un badge déclenche autre chose :

1. ajouter une entrée à `RFID_ACTIONS` (identifiant, libellé, forme du paramètre) ;
2. ajouter un `case` dans `runRfidBinding()` de `src/main.js`.

Le menu des Réglages se construit à partir du registre : il n'y a rien à
modifier dans l'interface. Actions livrées : `model`, `chat_mode`, `voice`.

#### Ouverture de session par badge

C'est le seul usage qui ne passe **pas** par ce registre, et volontairement.
Un badge de session est lié à un **profil**, pas à une action, et sa
vérification vit entièrement côté Rust (`session_unlock_rfid`) :

- l'UID est haché avec sel dans `session_profiles.json`, comme un mot de passe,
  et n'est jamais renvoyé à une webview ;
- lier ou retirer un badge exige le mot de passe courant du profil ;
- le blocage après cinq échecs est le même que pour le mot de passe ;
- un profil sans badge explicitement associé n'est jamais ouvert par ce chemin.

**Un UID de carte MIFARE n'est pas un secret** : il est diffusé en clair et se
clone avec un lecteur à quelques euros. Le badge est un facteur de commodité,
de l'ordre de la clé physique — pas un équivalent du mot de passe. L'écran de
connexion continue d'accepter les deux.

### Qui fait autorité

L'application. Le contrôleur n'est qu'une télécommande avec un écran : il
propose (`command`), l'application dispose (`state`). Concrètement le modèle
affiché est celui **réellement chargé en mémoire** (`/api/ps` pour Ollama,
`llama_status` pour llama-server), pas celui coché dans l'interface — c'est
pour ça que charger un modèle dans Ollama met l'écran à jour tout seul.

La couleur des LEDs fait exception : c'est un réglage purement local au
contrôleur, jamais envoyé à l'application.

L'application pousse son état à la connexion, à chaque changement, et en filet
de sécurité toutes les 3 s ; le catalogue (modèles **et voix installées**)
toutes les 60 s.
Rien n'est envoyé si la valeur n'a pas changé, et l'écran e-paper ne se
rafraîchit que si sa signature d'affichage diffère (`EPD_MIN_REFRESH_MS`).
