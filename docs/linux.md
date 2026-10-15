# Lumen Linux — build desktop x86_64

Ce build vise un Linux desktop standard (Debian/Ubuntu x86_64). Il utilise la
feature Cargo `linux-standard` :

- l'UI masque les options macOS / Shortcuts Apple ;
- les sources Ollama et API cloud restent disponibles ;
- les blocs matériels Raspberry Pi ne sont pas inclus.

## llama-server : variantes CPU, CUDA et Vulkan

```sh
node scripts/build-llama-server.mjs
```

Le script construit dans `src-tauri/resources/llama-server/linux-x64/` :

- `cpu/llama-server` — toujours construit, fonctionne sur toute machine ;
- `cuda/llama-server` — construit uniquement si `nvcc` est présent (CUDA
  Toolkit NVIDIA, cherché aussi dans `/usr/local/cuda/bin`) **et** que le
  pilote NVIDIA est installé sur la machine de build ;
- `vulkan/llama-server` — construit si le loader `libvulkan.so.1`, les en-têtes
  Vulkan et `glslc` sont présents. C'est le seul chemin GPU des machines AMD et
  Intel, et un repli utile sur NVIDIA quand le Toolkit CUDA manque.

`tauri build` relance ce script à chaque build. Il ne recompile pas pour
autant : un tampon (`linux-x64/.build-stamp`) mémorise la version de llama.cpp,
les réglages `LLAMA_*` et les chaînes d'outils GPU présentes ; tant que rien n'a
changé et que le binaire est là, le script rend la main aussitôt. Pour forcer
une reconstruction (nouvelle version épinglée dans `config/llama-cpp.version`
détectée automatiquement ; pilote mis à jour, non) :

```sh
LLAMA_FORCE_BUILD=1 node scripts/build-llama-server.mjs
```

La compilation utilise tous les cœurs (`nproc`) ; `CMAKE_BUILD_PARALLEL_LEVEL`
permet de la brider.

La deuxième condition n'est pas un excès de prudence. Tout binaire CUDA est lié
dynamiquement à `libcuda.so.1`, fournie par le **pilote** et non par le Toolkit.
Si elle manque, `linuxdeploy` ne peut pas résoudre les dépendances du binaire et
fait échouer l'AppImage entière (`Could not find dependency: libcuda.so.1`) —
alors que le `.deb`, lui, passe. L'échec arrive en toute fin de build et ne
mentionne pas llama.cpp. C'est le cas d'une VM ou d'un conteneur de build : le
Toolkit est installé, aucune carte n'est exposée. Le script saute alors la
variante CUDA en le disant, et supprime celle qu'une build précédente aurait
laissée — elle casserait l'AppImage de la même façon.

Pour produire un Lumen Linux avec CUDA, il faut donc compiler sur une machine
qui a le pilote NVIDIA, pas seulement le Toolkit.

`cmake` est requis dans les deux cas.

Si `nvcc` manque **alors qu'une carte NVIDIA répond à `nvidia-smi`**, le script
échoue au lieu de continuer : c'est le cas piégeux, où la build réussirait en
produisant un Lumen qui tourne sur le processeur sans que rien ne le signale.
`LLAMA_CUDA=0` permet d'assumer explicitement une version CPU seule. Sur une
machine sans carte du tout (y compris `linux-arm64` / Raspberry Pi), la variante
CPU seule est produite sans erreur.

Les architectures GPU compilées sont demandées à `nvcc --list-gpu-arch` puis
croisées avec celles que Lumen vise (Pascal 61 → Blackwell 120, dont Ampere 86
pour les RTX 30xx). Elles ne sont pas codées en dur : chaque version majeure du
Toolkit retire les plus anciennes — CUDA 13 a supprimé Pascal et Volta — et
`nvcc` refuse alors de compiler quoi que ce soit.

### Vulkan

Le loader suit la même règle que `libcuda.so.1` : sans lui sur la machine de
build, `linuxdeploy` fait échouer l'AppImage. Le script saute alors la variante
en le disant. `LLAMA_VULKAN=0` permet de l'exclure explicitement.

Côté exécution, Lumen ne retient Vulkan que si **deux** conditions sont
réunies : le loader `libvulkan.so.1` et au moins un manifeste de pilote dans
`/usr/share/vulkan/icd.d` (ou `/etc/vulkan/icd.d`). Tester le seul loader
donnerait un faux positif sur une machine où il est installé en dépendance d'un
paquet, sans pilote derrière : la variante Vulkan serait lancée et échouerait
au démarrage sans rien expliquer. Le nom du GPU vient de `vulkaninfo`
(paquet `vulkan-tools`) quand il est là ; son absence n'empêche rien.

### Choix au démarrage

Au démarrage, Lumen choisit la variante selon le réglage « Calcul llama.cpp »
(Réglages → source llama.cpp). En mode `auto`, l'ordre est CUDA, puis Vulkan,
puis CPU — sur une carte NVIDIA, CUDA reste sensiblement plus rapide que le même
modèle passé par Vulkan. Chaque chemin accéléré exige son binaire embarqué
**et** son matériel détecté. Le statut sous le réglage indique le backend
réellement utilisé, et la raison quand il diffère du choix. Hors CPU, le serveur
est lancé avec `--n-gpu-layers 999`.

## Steam Deck

SteamOS est un Linux x86_64 : le build `linux-standard` y tourne tel quel. Deux
particularités.

**Le format.** Le rootfs de SteamOS est immuable : le `.deb` n'y sert à rien,
viser l'AppImage. Elle se lance depuis le mode Bureau, et s'ajoute au mode
Gaming comme jeu non-Steam.

```sh
./scripts/build-linux.sh --bundles appimage
```

**Le GPU.** L'iGPU AMD (Van Gogh, RDNA2) n'a pas de chemin CUDA, et son `gfx1033`
n'est pas une cible officielle ROCm : Vulkan est le seul chemin GPU utilisable.
La variante est donc indispensable ici — sans elle, Lumen tourne entièrement sur
le processeur.

**Si la build ne se fait pas sur le Deck lui-même**, ajouter `LLAMA_NATIVE=0` :

```sh
LLAMA_NATIVE=0 ./scripts/build-llama-server.sh
```

Par défaut le script compile llama.cpp avec `GGML_NATIVE=ON`, qui encode les
extensions du processeur **exact** de la machine de compilation. C'est le bon
choix quand on compile sur la cible, mais un binaire ainsi produit sur un poste
récent meurt en « Instruction illicite » sur le Zen 2 du Deck — et l'erreur
apparaît au premier démarrage de llama.cpp, pas à la compilation.

Enfin, l'iGPU partage la RAM et l'UEFI ne lui réserve qu'un 1 Go de VRAM par
défaut (réglable à 4 Go). `--n-gpu-layers 999` laisse llama.cpp réduire de
lui-même, mais les modèles confortables ici sont les petits quantifiés 4 bits
(LFM2.5, Qwen 3–4B).

## Moteur vocal Piper

Piper est embarqué sur toutes les cibles Linux, x86 comme ARM. C'est nécessaire :
`tts_install_runtime` refuse d'installer le moteur hors macOS en répondant qu'il
est « fourni avec Lumen sur cette plateforme ». Ne pas le livrer laisserait donc
l'utilisateur sans moteur vocal et sans moyen d'en obtenir un.

`LUMEN_BUNDLE_PIPER=0` permet de l'exclure pour un bundle allégé, en connaissance
de cause. Lumen sait par ailleurs utiliser un `piper` présent dans le `PATH`,
dans `/opt/piper/` ou dans `/usr/local/bin/`.

Si Piper manque à l'exécution alors qu'il devrait être embarqué, vérifier sa
présence dans le paquet produit :

```sh
dpkg -c src-tauri/target/release/bundle/deb/*.deb | grep piper
```

Les chemins attendus sont `usr/lib/Lumen/resources/piper/linux-x64/…` — c'est
exactement ce que résout `piper_bundle_target` dans `src-tauri/src/tts.rs`.

> Le bundle Piper embarqué repose sur des liens symboliques. Un arbre de sources
> copié depuis un Mac ou via un dossier partagé VirtualBox les dégrade en
> fichiers texte, et `linuxdeploy` meurt en fin de build sur un
> `Failed to run ldd: exited with code 1` qui ne nomme pas le fautif.
> `build-linux.sh` détecte ce cas avant de compiler ; la réparation est
> `./scripts/piper/fetch-bundle.sh`, à lancer sur la machine Linux.

## Construire

Sur la machine Linux cible, sans `sudo` :

```sh
./scripts/install-prereqs-linux.sh
./scripts/build-linux.sh
```

Bundles produits dans `src-tauri/target/release/bundle/` (`.deb`, AppImage).

> Si le build échoue sur `libudev-sys` (« Package libudev was not found in the
> pkg-config search path »), c'est que le paquet de dev **libudev** manque : il est
> requis par `serialport`/`espflash` (flash des cartes MicroPython/ESP32). Le script
> `install-prereqs-linux.sh` l'installe désormais ; sinon, à la main :
>
> ```sh
> sudo apt-get install -y libudev-dev pkg-config
> ```

> Si le bundling s'arrête sur `failed to run linuxdeploy`, c'est FUSE : l'outil
> que Tauri télécharge pour fabriquer l'AppImage est lui-même une AppImage, et
> Ubuntu 22.04+ n'installe plus `libfuse2`. `build-linux.sh` exporte désormais
> `APPIMAGE_EXTRACT_AND_RUN=1`, qui contourne le problème sans `sudo`. En
> lançant `tauri build` à la main, exporte la même variable — ou installe
> `libfuse2` :
>
> ```sh
> sudo apt-get install -y libfuse2
> ```

> Si le build échoue **après** `Finished release` sur `Disk quota exceeded (os
> error 122)` alors que le disque a de la place : le bundler travaille dans
> `$TMPDIR` (`/tmp`), souvent un tmpfs limité ou sous quota. `build-linux.sh`
> pose désormais `TMPDIR` à côté de `target`. En lançant `tauri build` à la
> main, fais de même :
>
> ```sh
> mkdir -p ~/.cache/lumen-tmp && TMPDIR=~/.cache/lumen-tmp npm run tauri build -- --features linux-standard
> ```

Pour produire uniquement une AppImage :

```sh
./scripts/build-linux.sh --bundles appimage
```

> Comme pour le Raspberry Pi, le chemin fiable est un build natif Linux. La
> compilation croisée depuis macOS pour Tauri + WebKitGTK est possible en théorie,
> mais vite fragile à cause des dépendances système GTK/WebKit.


## Mode borne (kiosque)

Un poste dédié peut démarrer directement sur le **bureau de Lumen**, plein
écran, sans gestionnaire de fenêtres visible : borne d'atelier, poste d'accueil,
terminal de saisie.

```sh
sudo ./scripts/kiosk/install-kiosk.sh --app /chemin/vers/Lumen.AppImage
./scripts/kiosk/install-kiosk.sh --app /chemin/vers/Lumen.AppImage --dry-run
```

Le script installe **cage** (un compositeur Wayland qui n'affiche qu'une seule
fenêtre) et **greetd** (connexion automatique), crée un utilisateur dédié sans
droits d'administration, et pose une session qui relance Lumen s'il s'arrête —
une borne qui reste sur un écran noir n'est pas une borne.

Côté application, c'est la variable `LUMEN_KIOSK=1` qui fait ouvrir le bureau au
démarrage au lieu de la barre de recherche (cf. `src-tauri/src/lib.rs`, « Mode
borne »). Une variable d'environnement plutôt qu'un réglage : le réglage vit
dans le stockage de la webview, qu'un script d'installation ne peut pas
préparer.

**Ce que le script ne fait pas**, et qu'il faut faire soi-même : verrouiller le
BIOS et le démarrage sur support externe, fermer les consoles virtuelles si le
poste est en libre accès, chiffrer le disque si la borne porte des données. Un
kiosque logiciel n'est pas un kiosque physique.
