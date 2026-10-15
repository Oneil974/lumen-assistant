#!/usr/bin/env bash
# Construit whisper-server (whisper.cpp) pour la plateforme courante, déposé dans
# src-tauri/resources/whisper-server/<cible>/ et embarqué par Tauri. Même
# démarche que build-llama-server.sh : version épinglée (config/whisper-cpp.version),
# binaire statique (aucune dépendance au dossier de build ni à Homebrew), Metal
# sur Apple Silicon, tampon pour ne pas tout recompiler à chaque `tauri build`.
#   WHISPER_FORCE_BUILD=1  force la reconstruction
#   WHISPER_VULKAN=1       variante Vulkan (Linux) si les en-têtes et glslc sont là
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${WHISPER_CPP_VERSION:-$(tr -d '[:space:]' < "$ROOT/config/whisper-cpp.version")}"
SRC="${WHISPER_CPP_SOURCE:-$ROOT/.localtarget/whisper.cpp-$VERSION}"
OUT="$ROOT/src-tauri/resources/whisper-server"
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"

CMAKE_BIN="${CMAKE_BIN:-$(command -v cmake || true)}"
if [ "$HOST_OS" = "Darwin" ] && [ "$HOST_ARCH" = "arm64" ] && [ -x /opt/homebrew/bin/cmake ]; then CMAKE_BIN=/opt/homebrew/bin/cmake; fi
[ -x "${CMAKE_BIN:-}" ] || { echo "cmake est requis" >&2; exit 1; }
command -v git >/dev/null || { echo "git est requis" >&2; exit 1; }

clean_macos_metadata() { [ -d "$1" ] && find "$1" -type f \( -name '._*' -o -name '.DS_Store' \) -delete || true; }

case "$HOST_OS/$HOST_ARCH" in
  Darwin/arm64|Darwin/arm64e) TARGET="macos-arm64"; BACKEND=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON) ;;
  Darwin/x86_64) TARGET="macos-x64"; BACKEND=(-DGGML_METAL=OFF) ;;
  Linux/aarch64|Linux/arm64) TARGET="linux-arm64"; BACKEND=() ;;
  Linux/x86_64|Linux/amd64) TARGET="linux-x64"; BACKEND=() ;;
  *) echo "Architecture non supportée automatiquement: $HOST_OS/$HOST_ARCH" >&2; exit 1 ;;
esac
if [ "$HOST_OS" = "Linux" ] && [ "${WHISPER_VULKAN:-0}" = "1" ]; then BACKEND+=(-DGGML_VULKAN=ON); fi

STAMP="$OUT/$TARGET/.build-stamp"
STAMP_KEY="$VERSION $TARGET ${BACKEND[*]:-cpu}"
if [ "${WHISPER_FORCE_BUILD:-0}" != "1" ] && [ -x "$OUT/$TARGET/whisper-server" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$STAMP_KEY" ]; then
  echo "✓ whisper-server $VERSION déjà construit → $OUT/$TARGET (WHISPER_FORCE_BUILD=1 pour forcer)"
  exit 0
fi

if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$(dirname "$SRC")"
  git clone https://github.com/ggml-org/whisper.cpp.git "$SRC"
fi
git -C "$SRC" fetch --tags --quiet origin "$VERSION" 2>/dev/null || echo "⚠ whisper.cpp : mise à jour réseau impossible, clone local utilisé." >&2
git -C "$SRC" checkout --quiet "$VERSION"
clean_macos_metadata "$SRC"

BUILD="$SRC/build-lumen-$TARGET"
CMAKE_ARGS=(
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DGGML_NATIVE=OFF
  -DWHISPER_BUILD_SERVER=ON
  -DWHISPER_BUILD_EXAMPLES=ON
  -DWHISPER_BUILD_TESTS=OFF
  -DWHISPER_SDL2=OFF
  -DWHISPER_CURL=OFF
)
[ "$HOST_OS" = "Darwin" ] && CMAKE_ARGS+=("-DCMAKE_OSX_ARCHITECTURES=$HOST_ARCH")
if [ "$HOST_OS" = "Linux" ]; then JOBS="$(nproc 2>/dev/null || echo 4)"; else JOBS=2; fi

"$CMAKE_BIN" -S "$SRC" -B "$BUILD" "${CMAKE_ARGS[@]}" "${BACKEND[@]}"
"$CMAKE_BIN" --build "$BUILD" --config Release --target whisper-server -j "${CMAKE_BUILD_PARALLEL_LEVEL:-$JOBS}"
clean_macos_metadata "$BUILD"
BIN="$BUILD/bin/whisper-server"; [ -x "$BIN" ] || BIN="$BUILD/bin/Release/whisper-server"
[ -x "$BIN" ] || { echo "whisper-server introuvable dans $BUILD" >&2; exit 1; }

mkdir -p "$OUT/$TARGET"
DEST="$OUT/$TARGET/whisper-server"
install -m 755 "$BIN" "$DEST"
if [ "$HOST_OS" = "Darwin" ]; then
  # Refuser un binaire qui ne marcherait que grâce au dossier de build ou à Homebrew.
  BAD="$(otool -L "$DEST" | grep -v -F "$DEST:" | grep -E "/Volumes/|/opt/homebrew/|/usr/local/opt/|@rpath/(libwhisper|libggml)" || true)"
  if [ -n "$BAD" ]; then echo "whisper-server contient une dépendance non portable :" >&2; echo "$BAD" >&2; exit 1; fi
fi
cp "$SRC/LICENSE" "$OUT/$TARGET/whisper.cpp-LICENSE.txt"
printf '%s\n' "$VERSION" > "$OUT/$TARGET/VERSION"
printf '%s' "$STAMP_KEY" > "$STAMP"
clean_macos_metadata "$OUT/$TARGET"
echo "✓ whisper-server $VERSION → $OUT/$TARGET"
