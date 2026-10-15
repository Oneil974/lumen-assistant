#!/bin/bash
# Assistant interactif d'installation pour « Lumen Pi » sur Raspberry Pi OS.
# Installe les prérequis de build/runtime, puis propose les modules locaux :
# voix Piper, dictée whisper.cpp et service GPIO (pigpiod ou pigpio-lite).
#
# À lancer UNE FOIS, SANS sudo :
#   ./scripts/install-prereqs-pi.sh
#
# Mode non interactif :
#   ./scripts/install-prereqs-pi.sh --yes
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Ne lance PAS ce script en root : ./scripts/install-prereqs-pi.sh (sans sudo)." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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

choose() {
  local prompt="$1" default="$2" answer
  if [ "$ASSUME_YES" -eq 1 ]; then
    echo "$default"
    return
  fi
  read -r -p "$prompt [$default] " answer
  echo "${answer:-$default}"
}

install_base_prereqs() {
  echo "→ Dépendances système (apt, sudo)"
  sudo apt-get update
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev build-essential curl wget file git cmake \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
    pkg-config alsa-utils pulseaudio-utils python3 python3-venv \
    fonts-noto-color-emoji

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

install_gpio_service() {
  local model service
  model="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || true)"
  service="pigpiod"
  if echo "$model" | grep -qi "Raspberry Pi 5"; then
    service="pigpio-lite"
  fi
  echo "→ Modèle détecté : ${model:-inconnu}"
  echo "→ Service GPIO recommandé : $service"
  if [ "$service" = "pigpio-lite" ]; then
    sudo "$ROOT/scripts/pigpio-lite/install.sh"
  else
    sudo apt-get install -y pigpio
    sudo systemctl enable --now pigpiod || {
      echo "  pigpiod n'a pas démarré. Installation de pigpio-lite en remplacement."
      sudo "$ROOT/scripts/pigpio-lite/install.sh"
    }
  fi
}

install_piper_and_voices() {
  sudo "$ROOT/scripts/piper/install.sh"
  if ask "Télécharger une voix française Piper maintenant ?" "Y"; then
    install_piper_voice "fr_FR-siwis-medium" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx.json"
  fi
  if ask "Télécharger une voix anglaise Piper maintenant ?" "N"; then
    install_piper_voice "en_US-lessac-medium" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"
  fi
}

install_piper_voice() {
  local name="$1" model_url="$2" config_url="$3" dir="/opt/lumen/voices/piper"
  echo "→ Téléchargement de la voix $name"
  sudo install -d "$dir"
  sudo wget -qO "$dir/$name.onnx" "$model_url"
  sudo wget -qO "$dir/$name.onnx.json" "$config_url"
  if [ ! -e "/opt/piper/voices" ]; then sudo ln -s "$dir" /opt/piper/voices 2>/dev/null || true; fi
  echo "  Voix installée : $dir/$name.onnx"
}

install_dictation() {
  local model
  model="$(choose "Modèle whisper.cpp pour la dictée (tiny/base/small)" "base")"
  sudo "$ROOT/scripts/whisper/install.sh" "$model"
}

echo "Assistant d'installation Lumen Pi"
echo "---------------------------------"
echo "Ce script peut installer les prérequis, les voix, la dictée locale et le service GPIO."
echo

if ask "Installer/mettre à jour les prérequis système, Rust et Node.js ?" "Y"; then
  install_base_prereqs
fi
if ask "Installer/configurer le service GPIO (pigpiod ou pigpio-lite) ?" "Y"; then
  install_gpio_service
fi
if ask "Installer la synthèse vocale Piper et des voix ?" "Y"; then
  install_piper_and_voices
fi
if ask "Installer la dictée locale whisper.cpp ?" "Y"; then
  install_dictation
fi

echo
echo "✓ Assistant terminé."
echo "  Ouvre un nouveau terminal (ou : source \$HOME/.cargo/env) puis lance :"
echo "    ./scripts/build-pi.sh"
echo "  GPIO : sudo systemctl status pigpiod  ou  sudo systemctl status pigpio-lite"
