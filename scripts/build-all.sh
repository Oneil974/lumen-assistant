#!/bin/bash
# Construit Lumen (un seul binaire) et Lumen Server (produit distinct).
#
#   ./scripts/build-all.sh                 # les deux produits
#   ./scripts/build-all.sh lumen           # seulement Lumen
#   ./scripts/build-all.sh server          # seulement le serveur
#   ./scripts/build-all.sh --dry-run       # vérifier les commandes
#   ./scripts/build-all.sh --keep-going    # continuer après un échec
#
# Délègue aux scripts de la plateforme ; ne publie aucun artefact.
# « pro » est un alias de compatibilité pour « lumen », jamais une seconde build.

set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

DRY_RUN=0
KEEP_GOING=0
TARGETS=()

usage() {
  awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
  cat <<'USAGE'

Cibles : lumen | server   (aucune = lumen ; pro = alias de lumen)

Options :
  --dry-run       Affiche les commandes sans les exécuter
  --keep-going    Continue après l'échec d'un produit
  -h, --help      Cette aide
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    lumen|server) TARGETS+=("$1"); shift ;;
    pro) echo "pro : alias obsolète de lumen (un seul binaire)." >&2; TARGETS+=("lumen"); shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --keep-going) KEEP_GOING=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Argument inconnu : $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(lumen)
UNIQUE_TARGETS=()
for target in "${TARGETS[@]}"; do
  found=0
  for seen in ${UNIQUE_TARGETS[@]+"${UNIQUE_TARGETS[@]}"}; do [ "$seen" = "$target" ] && found=1; done
  [ "$found" = "1" ] || UNIQUE_TARGETS+=("$target")
done
TARGETS=("${UNIQUE_TARGETS[@]}")

# ---------------------------------------------------------------------------
# Présentation
# ---------------------------------------------------------------------------

BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RESET=$(printf '\033[0m')
[ -t 1 ] || { BOLD=""; DIM=""; RESET=""; }

step()  { printf '\n%s▸ %s%s\n' "$BOLD" "$*" "$RESET"; }
note()  { printf '  %s%s%s\n' "$DIM" "$*" "$RESET"; }
fail()  { printf '  ✗ %s\n' "$*" >&2; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  %s[dry-run]%s %s\n' "$DIM" "$RESET" "$*"
    return 0
  fi
  "$@"
}

# Résultats, pour le récapitulatif final.
RESULTS=()
FAILED=0

record() { RESULTS+=("$1"); }

# Un produit qui échoue n'arrête pas forcément les autres : quand on lance les
# trois avant de partir déjeuner, mieux vaut deux livrables et un échec identifié
# que rien du tout.
guard() {
  local name="$1"; shift
  if "$@"; then
    record "  ✓ $name"
  else
    record "  ✗ $name"
    FAILED=1
    fail "$name : échec (voir plus haut)"
    [ "$KEEP_GOING" = "1" ] || return 1
  fi
  return 0
}

PLATFORM="$(uname -s)"
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version" 2>/dev/null || echo "?")

# ---------------------------------------------------------------------------
# Lumen / Lumen Pro
# ---------------------------------------------------------------------------
#
# On délègue au script de la plateforme quand il existe : il porte les
# contournements qu'on ne veut pas réécrire (CI=true pour le DMG, déblayage de
# bundle/macos, refus du build en root sous Linux…).

build_app() {
  case "$PLATFORM" in
    Darwin) run bash scripts/build-macos.sh ;;
    Linux)  run bash scripts/build-linux.sh ;;
    *) run npm run tauri build ;;
  esac
}

# ---------------------------------------------------------------------------
# Lumen Server
# ---------------------------------------------------------------------------
#
# Produit DISTINCT : son propre workspace Cargo, son propre `target/`, aucune
# dépendance à l'application. Le binaire est autonome (console web incorporée) :
# le livrable, c'est un fichier.

build_server() {
  [ -d lumen-server ] || { fail "lumen-server/ est absent de ce dépôt."; return 1; }
  if [ "$DRY_RUN" = "1" ]; then
    run bash scripts/build-llama-server.sh || return 1
    run bash -c 'cd lumen-server && ./scripts/build.sh' || return 1
    return 0
  fi
  run bash scripts/build-llama-server.sh || return 1
  run bash -c 'cd lumen-server && ./scripts/build.sh' || return 1
  note "paquet Lumen Server autonome (démon + llama.cpp) créé dans dist/"
  return 0
}

# ---------------------------------------------------------------------------
# Exécution
# ---------------------------------------------------------------------------

printf '%sLumen — construction%s  ·  version %s  ·  %s %s\n' "$BOLD" "$RESET" "$VERSION" "$PLATFORM" "$(uname -m)"
note "cibles : ${TARGETS[*]}"
[ "$DRY_RUN" = "1" ] && note "simulation : rien ne sera compilé"
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  note "sans TAURI_SIGNING_PRIVATE_KEY : pas de fichiers .sig, donc pas de publication d'updater"
fi

for target in "${TARGETS[@]}"; do
  case "$target" in
    lumen)
      step "Lumen"
      guard "Lumen" build_app || break
      ;;
    server)
      step "Lumen Server — démon et console"
      guard "Lumen Server" build_server || break
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Récapitulatif
# ---------------------------------------------------------------------------

step "Récapitulatif"
for line in ${RESULTS[@]+"${RESULTS[@]}"}; do printf '%s\n' "$line"; done

if [ "$DRY_RUN" != "1" ] && [ -d dist ]; then
  printf '\n  %sLivrables dans dist/%s\n' "$BOLD" "$RESET"
  # Une boucle plutôt qu'un `ls | awk` : « Lumen Pro_0.1.1_aarch64.dmg » contient
  # une espace, et découper la sortie de `ls` sur les blancs affichait
  # « Pro_0.1.1_aarch64.dmg » — un nom de fichier qui n'existe pas.
  find dist -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.AppImage' -o -name '*.deb' \
    -o -name '*.exe' -o -name 'lumen-serverd-*' -o -name 'lumen-server-*.tar.gz' -o -name 'llama-server' \) -print0 2>/dev/null \
  | while IFS= read -r -d "" file; do
      size=$(du -h "$file" | cut -f1)
      printf '    %-8s %s\n' "$size" "$file"
    done
fi

if [ "$FAILED" != "0" ]; then
  printf '\n  Au moins un produit a échoué.\n' >&2
  exit 1
fi
printf '\n  Terminé.\n'
