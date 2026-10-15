#!/bin/bash
# Test Kokoro EN DEHORS de Lumen, pour diagnostiquer « pas de son ».
# Sépare les deux étapes : (1) synthèse Python → WAV, (2) lecture audio.
# Ainsi on sait si le problème vient de Kokoro/Python ou du périphérique audio.
#
#   ./scripts/kokoro/test.sh                 # voix ff_siwis, phrase par défaut
#   ./scripts/kokoro/test.sh af_heart "Hello there"
set -e

VOICE="${1:-ff_siwis}"
TEXT="${2:-Bonjour, ceci est un test de la voix Kokoro.}"

# Dossier modèle = app_data_dir Tauri sous Linux : $XDG_DATA_HOME/<identifier>/kokoro
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/com.lumen.app/kokoro"
MODEL="$DATA/model.onnx"
VOICES="$DATA/voices.bin"

PY="/opt/kokoro-venv/bin/python3"
[ -x "$PY" ] || PY="python3"
SCRIPT="$(dirname "$0")/kokoro_tts.py"
WAV="/tmp/kokoro_test.wav"

echo "Python  : $PY"
echo "Modèle  : $MODEL"
echo "Voices  : $VOICES"
echo "Voix    : $VOICE"
echo

if [ ! -f "$MODEL" ] || [ ! -f "$VOICES" ]; then
  echo "✗ Modèle Kokoro absent. Télécharge une voix Kokoro dans Lumen → Réglages → Synthèse vocale." >&2
  exit 1
fi

echo "→ [1/2] Synthèse (les erreurs Python s'affichent ici)…"
echo "$TEXT" | "$PY" "$SCRIPT" --model "$MODEL" --voices "$VOICES" --voice "$VOICE" > "$WAV"
echo "  WAV produit : $(ls -l "$WAV" | awk '{print $5}') octets — $(file -b "$WAV")"
echo

echo "→ [2/2] Lecture audio…"
if command -v pw-play >/dev/null 2>&1; then
  echo "  (pw-play / PipeWire)"; pw-play "$WAV"
elif command -v paplay >/dev/null 2>&1; then
  echo "  (paplay / PulseAudio)"; paplay "$WAV"
else
  echo "  (aplay / ALSA)"; aplay "$WAV"
fi

echo
echo "✓ Si tu as entendu la voix, Kokoro est OK."
echo "  Sinon : compare 'aplay -l' (cartes ALSA) et 'pactl info' (sortie PipeWire/Pulse)."
