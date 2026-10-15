#!/usr/bin/env sh
# Produit les STL des deux finitions du boîtier.
#
# OpenSCAD n'est pas une dépendance de Lumen : ce script suppose qu'il est
# installé sur la machine de celui qui imprime (`brew install --cask openscad`,
# `apt install openscad`).
set -eu

SCAD="${SCAD:-openscad}"
OUT="${1:-stl}"
BOARD="${BOARD:-pi5}"

command -v "$SCAD" >/dev/null 2>&1 || {
  echo "OpenSCAD introuvable. Installez-le, ou donnez son chemin : SCAD=/chemin/openscad $0" >&2
  exit 1
}

mkdir -p "$OUT"
# La coque et le couvercle sont IDENTIQUES d'une finition à l'autre : seule la
# plaque d'insert change de filament. C'est ce qui permet d'imprimer un jeu de
# coques et de décider de la couleur après coup.
for part in shell lid; do
  echo "→ $OUT/lumen-pi-$part-$BOARD.stl"
  "$SCAD" -D "PART=\"$part\"" -D "BOARD=\"$BOARD\"" -o "$OUT/lumen-pi-$part-$BOARD.stl" lumen-pi-case.scad
done
for flavor in gold red; do
  echo "→ $OUT/lumen-pi-insert-$flavor.stl"
  "$SCAD" -D 'PART="insert"' -D "FLAVOR=\"$flavor\"" -o "$OUT/lumen-pi-insert-$flavor.stl" lumen-pi-case.scad
done
echo
echo "Fait. Imprimez la coque et le couvercle en noir, l'insert dans le métal choisi."
