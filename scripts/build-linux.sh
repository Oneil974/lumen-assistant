#!/bin/bash
# Build « Lumen Linux » — desktop Linux x86_64 standard.
#
# À exécuter SUR la machine Linux cible, SANS sudo. La compilation croisée depuis
# macOS de Tauri + WebKitGTK reste fragile ; le chemin fiable est un build natif
# Linux. Active la feature `linux-standard` : UI sans Shortcuts Apple, mais sans
# blocs matériels Raspberry Pi.
#
# Prérequis (une fois) : ./scripts/install-prereqs-linux.sh
# AppImage seule       : ./scripts/build-linux.sh --bundles appimage
#
# Steam Deck : viser l'AppImage (SteamOS a un rootfs immuable, le .deb n'y sert
# à rien) et compiler la variante Vulkan de llama.cpp, seul chemin GPU de son
# iGPU AMD. Si la build ne se fait PAS sur le Deck lui-même, ajouter
# LLAMA_NATIVE=0 avant `./scripts/build-llama-server.sh` : sinon llama-server
# embarque les extensions du processeur de compilation et meurt en
# « Instruction illicite » sur le Zen 2 du Deck.
#   LLAMA_NATIVE=0 ./scripts/build-llama-server.sh
#   ./scripts/build-linux.sh --bundles appimage
# Par défaut, le script produit seulement .deb + AppImage. Tout argument passé au
# script est transmis à `tauri build` et peut remplacer ce choix.
set -e

cd "$(dirname "$0")/.."

if [ "$(id -u)" -eq 0 ]; then
  echo "Ne lance PAS ce build en root (sudo) : il créerait des fichiers root dans" >&2
  echo "node_modules/ et target/. Relance sans sudo : ./scripts/build-linux.sh" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "✗ Rust (cargo) introuvable. Lance d'abord : ./scripts/install-prereqs-linux.sh" >&2
  exit 1
fi

# src-tauri/.cargo/config.toml peut pointer vers un target-dir propre au poste de
# dev macOS. On force un répertoire local Linux pour produire des bundles propres.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/src-tauri/target}"

if [ -d node_modules ] && \
   [ -n "$(find node_modules -not -user "$(id -un)" -print -quit 2>/dev/null)" ]; then
  echo "→ node_modules contient des fichiers non possédés par $(id -un) : nettoyage (sudo)"
  sudo rm -rf node_modules package-lock.json
fi

echo "→ Dépendances frontend"
npm install

# `linuxdeploy`, que Tauri télécharge pour fabriquer l'AppImage, est lui-même
# une AppImage : la monter exige FUSE 2, absent d'Ubuntu 22.04+ (le paquet
# libfuse2 n'y est plus installé par défaut). L'échec remonte alors sous la
# forme opaque « failed to run linuxdeploy », après une compilation complète.
# Cette variable lui fait extraire son contenu au lieu de le monter : pas de
# FUSE, pas de sudo, et le .deb comme l'AppImage sortent du même build.
export APPIMAGE_EXTRACT_AND_RUN=1

# Extraction et fichiers de travail du bundler dans $TMPDIR — donc /tmp par
# défaut, qui sur bien des machines est un tmpfs de quelques Go ou soumis à un
# quota : le build meurt APRÈS la compilation sur « Disk quota exceeded (os
# error 122) » alors que le disque est loin d'être plein. On travaille à côté
# de `target`, sur le vrai disque. Une valeur TMPDIR posée par l'appelant
# est respectée.
export TMPDIR="${TMPDIR:-$CARGO_TARGET_DIR/tmp}"
mkdir -p "$TMPDIR"

# Tauri ne purge rien entre deux builds : il recopie les ressources par-dessus
# les anciennes. Un fichier qui a cessé d'être livré (typiquement la variante
# CUDA de llama-server quand la machine n'a pas le pilote NVIDIA) survit donc
# dans les arborescences d'empaquetage, et linuxdeploy continue de buter dessus
# alors que les sources sont propres.
#
# On efface tout `bundle/`, pas seulement l'AppDir : l'AppImage est fabriquée à
# partir de l'arborescence du .deb (`bundle/deb/<app>/data/`), qui est le second
# endroit où la copie périmée se cache. L'empaquetage est court comparé à la
# compilation, donc repartir de zéro ne coûte presque rien.
rm -rf src-tauri/target/release/bundle

# `bundle.resources` embarque `resources/llama-server` en entier, donc les
# binaires de TOUTES les plateformes — un dossier de travail partagé avec un Mac
# ou un PC Windows fait ainsi entrer 200 Mo de llama-server.exe dans le .deb.
# On restreint à la cible courante en surchargeant la liste à la volée.
#
# Surcharge ici plutôt que dans un tauri.linux.conf.json : le fichier de config
# ne peut pas connaître l'architecture (x64 ou arm64 pour le Raspberry Pi), et
# un motif glob laisserait planer un doute sur l'arborescence produite. Or
# `binary_roots` (src-tauri/src/llama.rs) attend exactement
# `resources/llama-server/<cible>/llama-server` : un chemin aplati ferait échouer
# le démarrage de llama.cpp sans message clair.
#
# `resources/piper` a la même structure (`resources/piper/<cible>`, résolue par
# `piper_bundle_target` dans src-tauri/src/tts.rs) et le même défaut : il livre
# aussi linux-arm64, linux-armv7 et windows-x64. Faire parcourir à linuxdeploy
# des bibliothèques ARM sur une machine x86 n'a aucun sens.
CONFIG_ARGS=()
case "$(uname -m)" in
  aarch64|arm64) LLAMA_TARGET="linux-arm64"; PIPER_TARGET="linux-arm64" ;;
  armv7l|armv7|armhf) LLAMA_TARGET="linux-arm64"; PIPER_TARGET="linux-armv7" ;;
  *) LLAMA_TARGET="linux-x64"; PIPER_TARGET="linux-x64" ;;
esac
# Piper est embarqué sur toutes les cibles Linux : `tts_install_runtime`
# (src-tauri/src/tts.rs) refuse d'installer le moteur hors macOS en répondant
# qu'il est « fourni avec Lumen sur cette plateforme ». Ne pas le livrer ici
# laisserait donc l'utilisateur sans moteur vocal ET sans moyen d'en obtenir un.
# LUMEN_BUNDLE_PIPER=0 permet de l'exclure pour un bundle allégé.
BUNDLE_PIPER="${LUMEN_BUNDLE_PIPER:-1}"

RES_LLAMA="resources/llama-server"
RES_PIPER="resources/piper"
# `if` explicites : avec `set -e`, un `[ -d … ] && VAR=…` dont le test échoue
# renvoie 1 en fin de liste et arrêterait le script.
if [ -d "src-tauri/$RES_LLAMA/$LLAMA_TARGET" ]; then
  RES_LLAMA="$RES_LLAMA/$LLAMA_TARGET"
fi
if [ -d "src-tauri/$RES_PIPER/$PIPER_TARGET" ]; then
  RES_PIPER="$RES_PIPER/$PIPER_TARGET"
fi
if [ "$BUNDLE_PIPER" = "1" ]; then
  RESOURCES="\"$RES_LLAMA\",\"$RES_PIPER\""
  echo "→ Ressources embarquées : $RES_LLAMA, $RES_PIPER"
else
  RESOURCES="\"$RES_LLAMA\""
  RES_PIPER=""
  echo "→ Ressources embarquées : $RES_LLAMA (Piper non embarqué sur $PIPER_TARGET)"
fi
CONFIG_ARGS=(--config "{\"bundle\":{\"resources\":[$RESOURCES]}}")

# Le bundle Piper repose sur des liens symboliques (libespeak-ng.so →
# libespeak-ng.so.1 → libespeak-ng.so.1.52.0.1). Un arbre de sources copié
# depuis un Mac ou un dossier partagé VirtualBox traverse souvent un système de
# fichiers sans symlinks : ils arrivent alors sous forme de fichiers texte
# contenant le nom de leur cible. linuxdeploy meurt dessus en fin de build, sur
# un « Failed to run ldd: exited with code 1 » qui ne nomme même pas le fautif.
PIPER_DIR="src-tauri/$RES_PIPER"
if [ -n "$RES_PIPER" ] && [ -d "$PIPER_DIR" ]; then
  # `-size -1024c` compte en octets. `-1k` arrondirait au bloc supérieur et ne
  # matcherait que les fichiers vides — un lien dégradé fait quelques dizaines
  # d'octets, une vraie bibliothèque en fait des centaines de milliers.
  BROKEN_LIBS="$(find "$PIPER_DIR" -maxdepth 1 -type f -name '*.so*' -size -1024c 2>/dev/null || true)"
  if [ -n "$BROKEN_LIBS" ]; then
    echo "✗ Bundle Piper corrompu : des liens symboliques sont arrivés sous forme" >&2
    echo "  de fichiers texte (copie via un système de fichiers sans symlinks)." >&2
    printf '%s\n' "$BROKEN_LIBS" | sed 's/^/    /' >&2
    echo "  Répare-le en le retéléchargeant sur cette machine :" >&2
    echo "    ./scripts/piper/fetch-bundle.sh" >&2
    exit 1
  fi
fi

echo "→ Build Tauri (feature linux-standard)"
if printf '%s\n' "$@" | grep -qx -- "--bundles"; then
  npm run tauri build -- --features linux-standard "${CONFIG_ARGS[@]}" "$@"
else
  npm run tauri build -- --features linux-standard --bundles deb,appimage "${CONFIG_ARGS[@]}" "$@"
fi

echo
echo "✓ Terminé. Bundles dans src-tauri/target/release/bundle/ (.deb / AppImage)."
