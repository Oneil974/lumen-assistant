#!/usr/bin/env bash
# Capture une démonstration réelle de la barre Lumen installée.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/docs/assets/tutorials/lumen-installed-interaction-raw.mov"

rm -f "$OUT"
screencapture -v -V 14 -D 1 -k -x "$OUT" &
CAPTURE_PID=$!
sleep 2
osascript -e 'tell application "Lumen" to activate'
sleep 1
# Le champ est volontairement focalisé à la main avant le lancement : certaines
# fenêtres translucides Tauri n'exposent pas leur zone de clic à Accessibility.
osascript -e 'tell application "System Events" to key code 0 using command down'
osascript -e 'tell application "System Events" to keystroke "Explique en une phrase le role des GPU en IA."'
sleep 1
osascript -e 'tell application "System Events" to key code 36'
wait "$CAPTURE_PID"
echo "$OUT"
