#!/bin/bash
# Build « Lumen Pi » — export Raspberry Pi.
#
# À exécuter SUR le Raspberry Pi (Raspberry Pi OS 64-bit), SANS sudo. La
# compilation croisée depuis macOS de Tauri + WebKitGTK est impraticable : on
# compile nativement sur l'appareil. Active la feature `rpi` (blocs GPIO/PWM/I²C/
# série + infos Pi, et saveur d'UI sans Apple Intelligence).
#
# Runtime LiteRT-LM (facultatif) : ./scripts/build-litert-runtime.sh, AVANT ce
# script. Sans lui, le bundle sort sans le moteur Google AI Edge et la source
# correspondante n'apparaît pas dans les Réglages — le reste est inchangé.
#
# Prérequis (une fois) : ./scripts/install-prereqs-pi.sh
# Build à RAM limitée : CARGO_BUILD_JOBS=2 ./scripts/build-pi.sh
# AppImage seule       : ./scripts/build-pi.sh --bundles appimage
# Par défaut, le script produit seulement .deb + AppImage. Tout argument passé au
# script est transmis à `tauri build` et peut remplacer ce choix.
set -e

cd "$(dirname "$0")/.."

if [ "$(id -u)" -eq 0 ]; then
  echo "Ne lance PAS ce build en root (sudo) : il créerait des fichiers root dans" >&2
  echo "node_modules/ et target/. Relance sans sudo : ./scripts/build-pi.sh" >&2
  exit 1
fi

# Rust dans le PATH (rustup ajoute la ligne au ~/.bashrc, mais pas forcément
# chargée dans ce shell non interactif).
if ! command -v cargo >/dev/null 2>&1; then
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "✗ Rust (cargo) introuvable. Lance d'abord : ./scripts/install-prereqs-pi.sh" >&2
  exit 1
fi

# src-tauri/.cargo/config.toml fixe un target-dir spécifique au Mac de dev
# (/Volumes/LiquidBuild, image disque montée par dev.sh) qui n'existe pas sur le
# Pi → « Permission denied ». On force un répertoire de build local : la variable
# d'environnement CARGO_TARGET_DIR prime sur build.target-dir du config.toml.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/src-tauri/target}"

# node_modules contenant des fichiers d'un autre propriétaire (essai précédent en
# sudo) → npm échoue sur EACCES. On nettoie (le rm a besoin de sudo).
if [ -d node_modules ] && \
   [ -n "$(find node_modules -not -user "$(id -un)" -print -quit 2>/dev/null)" ]; then
  echo "→ node_modules contient des fichiers non possédés par $(id -un) : nettoyage (sudo)"
  sudo rm -rf node_modules package-lock.json
fi

echo "→ Dépendances frontend"
npm install

# `bundle.resources` embarque `resources/litert` en entier, donc le venv de
# TOUTES les architectures si le dossier de travail est partagé avec une autre
# machine. On restreint à la cible courante, comme le fait build-linux.sh pour
# llama-server et Piper. `runtime_root` (src-tauri/src/litert.rs) attend
# exactement `resources/litert/<cible>/venv` : un chemin aplati laisserait la
# source LiteRT invisible, sans message d'erreur.
case "$(uname -m)" in
  aarch64|arm64) LITERT_TARGET="linux-arm64" ;;
  *) LITERT_TARGET="linux-x64" ;;
esac
CONFIG_ARGS=()
if [ -d "src-tauri/resources/litert/$LITERT_TARGET" ]; then
  echo "→ Runtime LiteRT-LM embarqué : resources/litert/$LITERT_TARGET"
  CONFIG_ARGS=(--config "{\"bundle\":{\"resources\":[\"resources/llama-server\",\"resources/litert/$LITERT_TARGET\",\"resources/piper\"]}}")
else
  echo "→ Runtime LiteRT-LM absent : bundle sans la source Google AI Edge."
  echo "  Pour l'inclure : ./scripts/build-litert-runtime.sh puis relance ce script."
  CONFIG_ARGS=(--config "{\"bundle\":{\"resources\":[\"resources/llama-server\",\"resources/piper\"]}}")
fi

echo "→ Build Tauri (feature rpi)"
# Le `--` transmet les arguments à la CLI Tauri ; "$@" relaie les arguments du
# script (ex. --bundles appimage). Sans --bundles explicite, on évite rpm.
if printf '%s\n' "$@" | grep -qx -- "--bundles"; then
  npm run tauri build -- --features rpi "${CONFIG_ARGS[@]}" "$@"
else
  npm run tauri build -- --features rpi --bundles deb,appimage "${CONFIG_ARGS[@]}" "$@"
fi

echo
echo "✓ Terminé. Bundles dans src-tauri/target/release/bundle/ (.deb / AppImage)."
echo "  Rappel : pigpiod doit tourner (sudo systemctl status pigpiod) pour le GPIO."
