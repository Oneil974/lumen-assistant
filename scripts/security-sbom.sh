#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/security"
mkdir -p "$OUT"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"
status=0

echo "== npm CycloneDX SBOM =="
if command -v npx >/dev/null 2>&1; then
  if npx --yes @cyclonedx/cyclonedx-npm --output-file "$OUT/lumen-$VERSION-npm.cdx.json"; then
    echo "npm SBOM: $OUT/lumen-$VERSION-npm.cdx.json"
  else
    code=$?
    echo "npm SBOM generation failed with exit code $code"
    status=1
  fi
else
  echo "npx not found; skipped"
  status=1
fi

echo
echo "== Cargo CycloneDX SBOM =="
if command -v cargo >/dev/null 2>&1 && cargo cyclonedx --version >/dev/null 2>&1; then
  (
    cd "$ROOT/src-tauri" &&
    cargo cyclonedx --format json --output-cdx
  ) && {
    found="$(find "$ROOT/src-tauri" -maxdepth 1 -name '*.cdx.json' -print -quit)"
    if [ -n "$found" ]; then
      cp "$found" "$OUT/lumen-$VERSION-cargo.cdx.json"
      echo "Cargo SBOM: $OUT/lumen-$VERSION-cargo.cdx.json"
    fi
  } || {
    code=$?
    echo "Cargo SBOM generation failed with exit code $code"
    status=1
  }
else
  echo "cargo-cyclonedx not installed; skipped"
  echo "Install with: cargo install cargo-cyclonedx"
fi

exit "$status"
