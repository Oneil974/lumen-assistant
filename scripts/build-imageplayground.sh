#!/usr/bin/env bash
# Compile la passerelle Image Playground (src-tauri/imageplayground/main.swift)
# en exécutable natif, déposé dans resources/imageplayground/<cible>/
# lumen-imageplayground où src-tauri/src/imageplayground.rs le cherche (mêmes
# conventions que lumen-applefm et llama-server).
#
# Prérequis : macOS 27 (SDK ImagePlayground 27 : style « any », taille,
# stratégie de création) et les Command Line Tools correspondants. Ailleurs le
# script ne fait rien : le moteur « Image Playground » n'apparaît pas.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src-tauri/imageplayground/main.swift"
OUT_ROOT="$ROOT/src-tauri/resources/imageplayground"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-imageplayground : réservé à macOS, rien à faire." >&2
  exit 0
fi

case "$(uname -m)" in
  arm64) TARGET_DIR="macos-arm64"; TRIPLE="arm64-apple-macos27.0" ;;
  x86_64) TARGET_DIR="macos-x64"; TRIPLE="x86_64-apple-macos27.0" ;;
  *) echo "Architecture non gérée : $(uname -m)" >&2; exit 1 ;;
esac

SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version 2>/dev/null || echo 0)"
if [ "${SDK_VERSION%%.*}" -lt 27 ]; then
  echo "build-imageplayground : SDK macOS $SDK_VERSION trop ancien (27 requis), passerelle non compilée." >&2
  exit 0
fi

OUT="$OUT_ROOT/$TARGET_DIR"
mkdir -p "$OUT"
echo "→ Compilation de lumen-imageplayground ($TRIPLE)"
xcrun swiftc -O \
  -target "$TRIPLE" \
  -framework AppKit -framework ImagePlayground -framework UniformTypeIdentifiers \
  "$SRC" -o "$OUT/lumen-imageplayground"
# Signature ad hoc : le bundle Tauri re-signe de toute façon les ressources.
codesign --force --sign - "$OUT/lumen-imageplayground" >/dev/null 2>&1 || true
echo "✓ $OUT/lumen-imageplayground"
