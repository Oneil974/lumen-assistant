#!/bin/bash
# Assistant d'installation pour « Lumen Linux » sur Debian/Ubuntu x86_64.
#
# À lancer UNE FOIS, SANS sudo :
#   ./scripts/install-prereqs-linux.sh
#
# Mode non interactif :
#   ./scripts/install-prereqs-linux.sh --yes
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Ne lance PAS ce script en root : ./scripts/install-prereqs-linux.sh (sans sudo)." >&2
  exit 1
fi

ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

ask() {
  local prompt="$1" default="${2:-Y}" answer
  if [ "$ASSUME_YES" -eq 1 ]; then
    echo "→ $prompt [oui]"
    return 0
  fi
  local suffix="[o/N]"
  [ "$default" = "Y" ] && suffix="[O/n]"
  read -r -p "$prompt $suffix " answer
  answer="${answer:-$default}"
  case "$answer" in
    o|O|oui|Oui|y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

install_base_prereqs() {
  echo "→ Dépendances système (apt, sudo)"
  sudo apt-get update
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev build-essential curl wget file git cmake \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
    libudev-dev pkg-config alsa-utils pulseaudio-utils python3 python3-venv \
    fonts-noto-color-emoji \
    libvulkan1 libvulkan-dev glslc mesa-vulkan-drivers

  if ! command -v cargo >/dev/null 2>&1; then
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "→ Installation de Rust (rustup)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    . "$HOME/.cargo/env"
  else
    echo "→ Rust déjà présent : $(cargo --version)"
  fi

  local need_node=1
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
    [ "${major:-0}" -ge 18 ] && need_node=0
  fi
  if [ "$need_node" -eq 1 ]; then
    echo "→ Installation de Node.js 20 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "→ Node déjà présent : $(node -v)"
  fi
}

echo "Assistant d'installation Lumen Linux"
echo "------------------------------------"
echo "Ce script installe les prérequis de build/runtime Tauri pour Linux x86_64."
echo

if ask "Installer/mettre à jour les prérequis système, Rust et Node.js ?" "Y"; then
  install_base_prereqs
fi

echo
echo "✓ Assistant terminé."
echo "  Ouvre un nouveau terminal (ou : source \$HOME/.cargo/env) puis lance :"
echo "    ./scripts/build-linux.sh"
