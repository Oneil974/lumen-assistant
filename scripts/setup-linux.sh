#!/bin/bash
# Installation runtime « tout-en-un » de Lumen sur Linux (Debian/Ubuntu x86_64).
#
# Met en place ce dont l'app a besoin pour fonctionner :
#   • Ollama (moteur LLM local) + un modèle par défaut ;
#   • Voix neuronales locales : Piper (rapide) et/ou Kokoro (haute qualité) ;
#   • Dictée locale : whisper.cpp (STT offline).
#
# À lancer UNE FOIS, SANS sudo (le script demande sudo quand il en a besoin) :
#   ./scripts/setup-linux.sh
# Non interactif (installe tout) :
#   ./scripts/setup-linux.sh --yes
# Modèle personnalisé :
#   LUMEN_MODEL="qwen2.5:3b" ./scripts/setup-linux.sh
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Ne lance PAS ce script en root : ./scripts/setup-linux.sh (sans sudo)." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${LUMEN_MODEL:-liquidai/lfm2.5-350m:latest}"
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

ask() {
  local prompt="$1" answer
  if [ "$ASSUME_YES" -eq 1 ]; then echo "→ $prompt [oui]"; return 0; fi
  read -r -p "$prompt [O/n] " answer
  case "${answer:-O}" in o|O|oui|Oui|y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

install_ollama() {
  if command -v ollama >/dev/null 2>&1; then
    echo "→ Ollama déjà présent : $(ollama --version 2>/dev/null | head -1)"
  else
    echo "→ Installation d'Ollama (script officiel)"
    curl -fsSL https://ollama.com/install.sh | sh
  fi
}

ensure_ollama_running() {
  if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then return 0; fi
  # Le script officiel installe un service systemd ; on le démarre au besoin.
  sudo systemctl enable --now ollama 2>/dev/null || (ollama serve >/tmp/lumen-ollama.log 2>&1 &) || true
  for _ in $(seq 1 30); do
    curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "  Ollama n'a pas répondu sur :11434. Lance « ollama serve » puis relance le pull." >&2
  return 1
}

# Télécharge une voix Piper (.onnx + .json) dans le dossier de données lu par l app.
install_piper_voice() {
  local name="$1" model_url="$2" config_url="$3" dir="${XDG_DATA_HOME:-$HOME/.local/share}/com.lumen.app/piper-voices"
  echo "→ Téléchargement de la voix Piper $name"
  mkdir -p "$dir"
  curl -fsSL "$model_url"  -o "$dir/$name.onnx"
  curl -fsSL "$config_url" -o "$dir/$name.onnx.json"
}

install_voices_piper() {
  sudo "$ROOT/scripts/piper/install.sh"
  install_piper_voice "fr_FR-siwis-medium" \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx" \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx.json"
  install_piper_voice "en_US-lessac-medium" \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx" \
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"
}

echo "=== Lumen · installation runtime Linux ==="
install_ollama
if ask "Télécharger le modèle Ollama « $MODEL » maintenant ?"; then
  ensure_ollama_running && { echo "→ ollama pull $MODEL"; ollama pull "$MODEL"; }
fi
if ask "Installer la voix locale Piper (+ voix FR & EN par défaut) ?"; then
  install_voices_piper
fi
if ask "Installer aussi Kokoro (voix neuronales haute qualité) ?"; then
  sudo "$ROOT/scripts/kokoro/install.sh"
fi
if ask "Installer la dictée locale whisper.cpp ?"; then
  model="base"
  [ "$ASSUME_YES" -eq 1 ] || read -r -p "Modèle whisper (tiny/base/small) [base] " model
  sudo "$ROOT/scripts/whisper/install.sh" "${model:-base}"
fi

cat <<EOF

✅ Terminé.
   • Modèle local : $MODEL (modifiable dans Réglages → IA).
   • Voix : choisis la voix active dans Réglages → Synthèse vocale.
   • Le téléchargement des modèles Kokoro se fait depuis ces mêmes réglages.
EOF
