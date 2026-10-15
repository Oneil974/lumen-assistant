#!/bin/bash
# Installe Piper sur Linux ou macOS.
#
# Linux utilise la dernière release historique MIT de `rhasspy/piper`. Les
# archives macOS de cette release sont inutilisables sur les Mac actuels (celle
# nommée aarch64 contient un binaire Intel et omet ses dylibs). macOS installe
# donc le runtime maintenu `piper-tts` dans un venv isolé de Lumen.
#
# Linux : sudo ./scripts/piper/install.sh
# macOS : ./scripts/piper/install.sh      (sans sudo)
set -euo pipefail

VERSION="2023.11.14-2"
MACOS_VERSION="1.5.0"
BASE_URL="https://github.com/rhasspy/piper/releases/download/${VERSION}"

os="$(uname -s)"
machine="$(uname -m)"

if [ "$os" = "Darwin" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    echo "Sur macOS, lance ce script SANS sudo : ./scripts/piper/install.sh" >&2
    exit 1
  fi
  command -v python3 >/dev/null 2>&1 || {
    echo "Python 3 est requis pour installer Piper sur macOS." >&2
    exit 1
  }
  runtime="$HOME/Library/Application Support/com.lumen.app/piper-runtime"
  echo "→ Installation de Piper $MACOS_VERSION pour macOS ($machine)"
  rm -rf "$runtime"
  python3 -m venv "$runtime"
  PIP_NO_CACHE_DIR=1 "$runtime/bin/python" -m pip install --disable-pip-version-check \
    "piper-tts==$MACOS_VERSION"
  "$runtime/bin/piper" --help >/dev/null
  echo "✓ Piper $MACOS_VERSION installé : $runtime/bin/piper"
  echo "  Redémarre Lumen s'il était ouvert pendant l'installation."
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Sous Linux, lance avec sudo : sudo ./scripts/piper/install.sh" >&2
  exit 1
fi

case "$os/$machine" in
  Linux/x86_64) archive="piper_linux_x86_64.tar.gz" ;;
  Linux/aarch64|Linux/arm64) archive="piper_linux_aarch64.tar.gz" ;;
  Linux/armv7l|Linux/armhf) archive="piper_linux_armv7l.tar.gz" ;;
  *) echo "Plateforme Piper MIT non gérée : $os/$machine" >&2; exit 1 ;;
esac

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Commande requise introuvable : $tool" >&2
    exit 1
  }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "→ Téléchargement de Piper MIT $VERSION ($os/$machine)"
curl --fail --location --show-error "$BASE_URL/$archive" -o "$tmp/piper.tar.gz"
mkdir -p "$tmp/unpacked"
tar -xzf "$tmp/piper.tar.gz" -C "$tmp/unpacked"

source_dir="$tmp/unpacked/piper"
if [ ! -x "$source_dir/piper" ]; then
  echo "Archive Piper invalide : binaire piper absent." >&2
  exit 1
fi

echo "→ Installation dans /opt/piper"
rm -rf /opt/piper
mkdir -p /opt
mv "$source_dir" /opt/piper
chmod +x /opt/piper/piper
mkdir -p /usr/local/bin
ln -sf /opt/piper/piper /usr/local/bin/piper

echo "✓ Piper MIT $VERSION installé : /opt/piper/piper"
echo "  Licence conservée dans /opt/piper (fichier LICENSE lorsqu'il est fourni)."
