#!/bin/bash
# Alimente `src-tauri/resources/piper/<cible>/` avec le moteur Piper à embarquer
# dans le bundle, comme on le fait déjà pour `llama-server`.
#
#   ./scripts/piper/fetch-bundle.sh          # la plateforme courante
#   ./scripts/piper/fetch-bundle.sh --all    # toutes les cibles (machine de build)
#
# macOS n'est PAS géré ici, volontairement : les archives officielles annoncées
# pour macOS contiennent un binaire x86_64 et omettent leurs dylibs
# (libespeak-ng, libpiper_phonemize, libonnxruntime) — elles ne s'exécutent pas.
# Sur macOS, Lumen installe le runtime `piper-tts` à la demande, en un clic
# depuis les Paramètres (commande `tts_install_runtime`).
set -euo pipefail

VERSION="2023.11.14-2"
BASE_URL="https://github.com/rhasspy/piper/releases/download/${VERSION}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST_ROOT="$ROOT/src-tauri/resources/piper"

# cible → archive
targets_all="linux-x64:piper_linux_x86_64.tar.gz
linux-arm64:piper_linux_aarch64.tar.gz
linux-armv7:piper_linux_armv7l.tar.gz
windows-x64:piper_windows_amd64.zip"

current_target() {
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) echo "linux-x64" ;;
    Linux/aarch64|Linux/arm64) echo "linux-arm64" ;;
    Linux/armv7l|Linux/armhf) echo "linux-armv7" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows-x64" ;;
    Darwin/*)
      echo "macOS : aucun binaire Piper embarquable (voir l'en-tête du script)." >&2
      echo "        Lumen y installe le moteur à la demande depuis les Paramètres." >&2
      exit 0 ;;
    *) echo "Plateforme non gérée : $(uname -s)/$(uname -m)" >&2; exit 1 ;;
  esac
}

fetch_one() {
  local target="$1" archive="$2"
  local dest="$DEST_ROOT/$target"
  echo "→ $target ($archive)"
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  curl --fail --location --show-error --progress-bar "$BASE_URL/$archive" -o "$tmp/piper.pkg"
  mkdir -p "$tmp/unpacked"
  case "$archive" in
    *.tar.gz) tar -xzf "$tmp/piper.pkg" -C "$tmp/unpacked" ;;
    *.zip)    unzip -q "$tmp/piper.pkg" -d "$tmp/unpacked" ;;
  esac

  local src="$tmp/unpacked/piper"
  [ -d "$src" ] || { echo "Archive inattendue : dossier piper/ absent." >&2; return 1; }
  # Le binaire attend ses dylibs et `espeak-ng-data` à côté de lui : on garde
  # l'arborescence de l'archive telle quelle.
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  mv "$src" "$dest"
  [ -f "$dest/piper.exe" ] || chmod +x "$dest/piper"
  echo "$VERSION" > "$dest/VERSION"
  echo "✓ $dest"
}

if [ "${1:-}" = "--all" ]; then
  echo "$targets_all" | while IFS=: read -r target archive; do
    fetch_one "$target" "$archive"
  done
else
  target="$(current_target)"
  archive="$(echo "$targets_all" | grep "^$target:" | cut -d: -f2)"
  fetch_one "$target" "$archive"
fi

echo
echo "Le moteur est déclaré dans src-tauri/tauri.conf.json (bundle.resources)."
echo "Licence Piper (MIT) conservée dans chaque dossier lorsqu'elle est fournie."
