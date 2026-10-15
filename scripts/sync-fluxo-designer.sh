#!/usr/bin/env bash
# Resynchronise les assets du designer Fluxo embarqué dans Lumen depuis le dépôt
# Fluxo. Le designer (éditeur de workflows) est copié tel quel ; seul
# designer.html est maintenu à la main (refs d'assets relatives).
#
# Usage :
#   scripts/sync-fluxo-designer.sh [chemin/vers/depot/Fluxo]
# Par défaut, suppose Fluxo en dépôt frère : ../Fluxo
set -euo pipefail

LUMEN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLUXO_ROOT="${1:-$LUMEN_ROOT/../Fluxo}"
SRC="$FLUXO_ROOT/app/src"
DST="$LUMEN_ROOT/src/fluxo"

if [ ! -d "$SRC" ]; then
  echo "✗ Source Fluxo introuvable : $SRC" >&2
  echo "  Passe le chemin du dépôt Fluxo en argument." >&2
  exit 1
fi

mkdir -p "$DST"
for f in main.js styles.css icons.js i18n.js; do
  cp "$SRC/$f" "$DST/$f"
  echo "✓ $f"
done

echo
echo "Assets synchronisés dans $DST."
echo "⚠️  designer.html n'est PAS écrasé (refs relatives maintenues à la main)."
echo "    Si index.html de Fluxo a changé de structure, reporte les modifs"
echo "    dans $DST/designer.html."
