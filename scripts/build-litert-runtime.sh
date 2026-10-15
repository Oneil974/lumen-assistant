#!/usr/bin/env bash
# Construit le runtime LiteRT-LM embarqué dans le build Raspberry Pi.
#
# LiteRT-LM ne se distribue pas en binaire autonome : c'est un CLI Python
# (`litert-lm`, quelques dizaines de Ko) posé sur une roue native
# (`litert-lm-api`, ~46 Mo, publiée en manylinux_2_27_aarch64). On fabrique donc
# ici un venv complet, copié tel quel dans les ressources du bundle.
#
# À exécuter SUR le Raspberry Pi (ou toute machine linux/aarch64 avec le même
# Python), AVANT ./scripts/build-pi.sh :
#   ./scripts/build-litert-runtime.sh
#
# LITERT_LM_VERSION surcharge la version épinglée dans config/litert-lm.version.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${LITERT_LM_VERSION:-$(tr -d '[:space:]' < "$ROOT/config/litert-lm.version")}"

HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
case "$HOST_OS/$HOST_ARCH" in
  Linux/aarch64|Linux/arm64) TARGET="linux-arm64" ;;
  Linux/x86_64|Linux/amd64) TARGET="linux-x64" ;;
  *)
    echo "LiteRT-LM n'est empaqueté que pour Linux x86_64/aarch64 (ici : $HOST_OS/$HOST_ARCH)." >&2
    echo "Le venv contient des roues natives : il doit être construit sur l'architecture cible." >&2
    exit 1
    ;;
esac
OUT="$ROOT/src-tauri/resources/litert/$TARGET"

# Le CLI exige Python 3.10+. Le vérifier ici évite un venv à moitié construit et
# une erreur de résolution pip qui ne nomme jamais la vraie contrainte.
PYTHON_BIN="${PYTHON_BIN:-python3}"
command -v "$PYTHON_BIN" >/dev/null || { echo "python3 est requis" >&2; exit 1; }
if ! "$PYTHON_BIN" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "✗ Python 3.10+ requis par litert-lm (trouvé : $("$PYTHON_BIN" --version))" >&2
  exit 1
fi
if ! "$PYTHON_BIN" -c 'import venv' 2>/dev/null; then
  echo "✗ Module venv absent. Debian/Ubuntu/Pi OS : sudo apt-get install python3-venv" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"

# --copies plutôt qu'un lien symbolique vers /usr/bin/python3 : le venv part dans
# un .deb, et dpkg ne recrée pas un symlink cassé de la même façon selon la
# version de Python installée sur la machine d'arrivée. La copie fige un
# interpréteur qui reste valable tant que libpython correspond — c'est le cas
# entre deux Pi OS de la même version, la cible visée ici.
"$PYTHON_BIN" -m venv --copies "$OUT/venv"
"$OUT/venv/bin/python" -m pip install --upgrade pip >/dev/null
"$OUT/venv/bin/python" -m pip install "litert-lm==$VERSION"

# Un venv enregistre son propre chemin absolu dans les scripts d'activation et
# dans le shebang de chaque console script. Après empaquetage, ce chemin n'existe
# plus (/home/pi/… → /usr/lib/lumen/…) : le shebang pointe dans le vide et
# `litert-lm` échoue en « bad interpreter ». Lumen n'appelle donc JAMAIS le
# script directement — il lance `venv/bin/python venv/bin/litert-lm`, qui ignore
# le shebang. On retire les scripts d'activation, qui n'ont plus de sens ici et
# ne feraient qu'induire en erreur qui explorerait le bundle.
rm -f "$OUT/venv/bin/activate"*

CLI="$OUT/venv/bin/litert-lm"
[ -f "$CLI" ] || { echo "✗ litert-lm introuvable dans le venv" >&2; exit 1; }
# Vérification de bout en bout : c'est le seul moment où l'on saura que la roue
# native correspond bien à cette architecture (une roue manquante se traduit
# sinon par un ImportError au premier message de l'utilisateur).
"$OUT/venv/bin/python" "$CLI" --version >/dev/null || {
  echo "✗ Le CLI litert-lm ne démarre pas dans ce venv." >&2
  exit 1
}

# Les caches de bytecode pèsent lourd et seront réécrits ailleurs de toute façon.
find "$OUT/venv" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
printf '%s\n' "$VERSION" > "$OUT/VERSION"
echo "✓ Runtime LiteRT-LM $VERSION → $OUT ($(du -sh "$OUT" | cut -f1))"
