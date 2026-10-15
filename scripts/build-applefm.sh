#!/usr/bin/env bash
# Compile la passerelle Apple Foundation Models (src-tauri/applefm/main.swift)
# en exécutable natif, déposé dans resources/applefm/<cible>/lumen-applefm où
# src-tauri/src/applefm.rs le cherche (mêmes conventions que llama-server).
#
# Prérequis : macOS 27 (SDK FoundationModels 27, modèle Private Cloud Compute)
# et les Command Line Tools / Xcode correspondants. Sur un autre système le
# script ne fait rien : la source « Apple Foundation Models » disparaît alors
# d'elle-même de Lumen.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src-tauri/applefm/main.swift"
OUT_ROOT="$ROOT/src-tauri/resources/applefm"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-applefm : réservé à macOS, rien à faire." >&2
  exit 0
fi

case "$(uname -m)" in
  arm64) TARGET_DIR="macos-arm64"; TRIPLE="arm64-apple-macos27.0" ;;
  x86_64) TARGET_DIR="macos-x64"; TRIPLE="x86_64-apple-macos27.0" ;;
  *) echo "Architecture non gérée : $(uname -m)" >&2; exit 1 ;;
esac

SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version 2>/dev/null || echo 0)"
if [ "${SDK_VERSION%%.*}" -lt 27 ]; then
  echo "build-applefm : SDK macOS $SDK_VERSION trop ancien (27 requis), passerelle non compilée." >&2
  exit 0
fi

OUT="$OUT_ROOT/$TARGET_DIR"
mkdir -p "$OUT"
echo "→ Compilation de lumen-applefm ($TRIPLE)"
xcrun swiftc -O -parse-as-library \
  -target "$TRIPLE" \
  -framework FoundationModels -framework Network -framework Security \
  "$SRC" -o "$OUT/lumen-applefm"
# Signature ad hoc : le framework exige un exécutable signé, et le bundle
# Tauri re-signe de toute façon les ressources avec l'identité de l'app.
codesign --force --sign - "$OUT/lumen-applefm" >/dev/null 2>&1 || true
echo "✓ $OUT/lumen-applefm"
