#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/security"
mkdir -p "$OUT"

status=0

print_json_audit_summary() {
  local file="$1"
  node - "$file" <<'NODE' 2>/dev/null || true
const fs = require("fs");
const file = process.argv[2];
const report = JSON.parse(fs.readFileSync(file, "utf8"));
const meta = report.metadata && report.metadata.vulnerabilities;
if (meta) {
  console.log(`vulnerabilities: total=${meta.total || 0}, critical=${meta.critical || 0}, high=${meta.high || 0}, moderate=${meta.moderate || 0}, low=${meta.low || 0}`);
}
const vulns = report.vulnerabilities || {};
for (const item of Object.values(vulns)) {
  console.log(`- ${item.name}: ${item.severity}${item.isDirect ? " (direct)" : ""}`);
}
NODE
}

echo "== npm audit =="
# TOUTES les dépendances : PDF.js, ExcelJS, KaTeX, MapLibre… sont des
# devDependencies, mais scripts/build-vendor.mjs les livre dans src/lib/vendor/.
# `--omit=dev` laissait ces composants embarqués hors de l'audit.
if command -v npm >/dev/null 2>&1; then
  npm audit --json > "$OUT/npm-audit.json" 2> "$OUT/npm-audit.stderr.txt"
  code=$?
  cat "$OUT/npm-audit.stderr.txt"
  print_json_audit_summary "$OUT/npm-audit.json"
  if [ "$code" -eq 0 ]; then
    echo "npm audit: ok"
  else
    echo "npm audit: failed with exit code $code"
    echo "See $OUT/npm-audit.json"
    echo "See $OUT/npm-audit.stderr.txt"
    status=1
  fi
else
  echo "npm not found; skipped"
  status=1
fi

echo
echo "== vendored browser libraries =="
# Versions réellement livrées (build-vendor.mjs) + croisement avec l'audit.
if command -v node >/dev/null 2>&1; then
  node "$ROOT/scripts/vendor-inventory.mjs" || status=1
  echo "See $OUT/vendored.json"
fi

echo
echo "== cargo audit =="
if command -v cargo >/dev/null 2>&1 && cargo audit --version >/dev/null 2>&1; then
  (
    cd "$ROOT/src-tauri" &&
    cargo audit --json > "$OUT/cargo-audit.json" 2> "$OUT/cargo-audit.stderr.txt"
  )
  code=$?
  cat "$OUT/cargo-audit.stderr.txt"
  if [ "$code" -eq 0 ]; then
    echo "cargo audit: ok"
  else
    echo "cargo audit: failed with exit code $code"
    echo "See $OUT/cargo-audit.json"
    echo "See $OUT/cargo-audit.stderr.txt"
    status=1
  fi
else
  echo "cargo-audit not installed; skipped"
  status=1
  echo "Install with Rust 1.86: cargo install cargo-audit --version 0.22.1 --locked"
  echo "Or update Rust first: rustup update stable"
fi

echo
echo "== cargo deny =="
if command -v cargo >/dev/null 2>&1 && cargo deny --version >/dev/null 2>&1; then
  deny_checks="advisories bans licenses sources"
  deny_version="$(cargo deny --version | awk '{print $2}')"
  case "$deny_version" in
    0.18.*)
      echo "cargo-deny $deny_version cannot parse RustSec CVSS 4.0 advisories."
      echo "Skipping cargo-deny advisories; cargo-audit covers RustSec advisories above."
      deny_checks="bans licenses sources"
      ;;
  esac
  if (
    cd "$ROOT/src-tauri" &&
    cargo deny check --help | grep -q -- "--format"
  ); then
    (
      cd "$ROOT/src-tauri" &&
      cargo deny check $deny_checks --format json > "$OUT/cargo-deny.json" 2> "$OUT/cargo-deny.stderr.txt"
    )
    code=$?
    cat "$OUT/cargo-deny.stderr.txt"
    if [ "$code" -eq 0 ]; then
      echo "cargo deny: ok"
    else
      echo "cargo deny: failed with exit code $code"
      echo "See $OUT/cargo-deny.json"
      echo "See $OUT/cargo-deny.stderr.txt"
      status=1
    fi
  else
    (
      cd "$ROOT/src-tauri" &&
      cargo deny check $deny_checks > "$OUT/cargo-deny.txt" 2>&1
    )
    code=$?
    cat "$OUT/cargo-deny.txt"
    if [ "$code" -eq 0 ]; then
      echo "cargo deny: ok"
    else
      echo "cargo deny: failed with exit code $code"
      echo "See $OUT/cargo-deny.txt"
      status=1
    fi
  fi
else
  echo "cargo-deny not installed; skipped"
  status=1
  echo "Install with Rust 1.86: cargo install cargo-deny --version 0.18.3 --locked"
  echo "Or update Rust first: rustup update stable"
fi

exit "$status"
