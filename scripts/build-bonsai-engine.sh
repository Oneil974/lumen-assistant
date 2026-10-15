#!/usr/bin/env bash
# Empaquette le moteur PrismML Bonsai Image (mflux + fork MLX sur Apple
# Silicon, gemlite/Triton sur GPU NVIDIA) en runtime Python AUTONOME, déposé
# dans src-tauri/resources/bonsai/<cible>/ où src-tauri/src/bonsai.rs le
# cherche — mêmes conventions que llama-server : une seule cible, celle de
# l'OS de compilation (macos-arm64, linux-x64 ; windows-x64 par le .ps1).
#
#   resources/bonsai/<cible>/
#     python/                 CPython autonome (python-build-standalone, via uv)
#                             avec mflux, mlx, prism-image-studio, torch…
#     lumen_bonsai_server.py  serveur de Lumen (src-tauri/bonsai/)
#     lumen-bonsai            lanceur shell (diagnostic à la main)
#     VERSION
#
# Prérequis : uv (https://astral.sh/uv), git, zip. Le moteur est OPTIONNEL :
# l'archive produite dans dist/bonsai-engine/ est publiée en Release GitHub
# (scripts/publish-bonsai-engine.sh) et Lumen la télécharge à la demande ; les
# MODÈLES viennent de Hugging Face (Catalogue → Modèles → Image).
#
# Le fork MLX de PrismML se compile depuis les sources et exige le Metal
# Toolchain d'Xcode. Sans lui, réutiliser un moteur DÉJÀ construit :
#   BONSAI_SOURCE_VENV=<venv du dépôt de démo>   (auto-détecté dans les données
#                                                 de Lumen : bonsai-official-venv)
# Les paquets de ce venv (même Python 3.11) sont recopiés dans le runtime,
# puis mflux/image-studio y sont réinstallés en NON éditable.
#
# Variables : BONSAI_DEMO_DIR (clone de Bonsai-Image-Demo, défaut .localtarget/),
# BONSAI_MLX_REV (commit du fork), BONSAI_PYTHON (3.11), BONSAI_SKIP_PROBE=1.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_ROOT="$ROOT/src-tauri/resources/bonsai"
SERVER_SRC="$ROOT/src-tauri/bonsai/lumen_bonsai_server.py"
PYVER="${BONSAI_PYTHON:-3.11}"
MLX_REV="${BONSAI_MLX_REV:-b9effaf65ecce0e99a2fb23c8962d34eff95b625}"
DEMO="${BONSAI_DEMO_DIR:-$ROOT/.localtarget/Bonsai-Image-Demo}"
ENGINE_VERSION="$(date +%Y%m%d)-mlx${MLX_REV:0:8}"

HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
case "$HOST_OS/$HOST_ARCH" in
  Darwin/arm64|Darwin/arm64e) TARGET="macos-arm64"; KIND="mlx" ;;
  Darwin/x86_64)
    echo "build-bonsai-engine : mflux exige Apple Silicon ; pas de moteur Bonsai pour macOS Intel." >&2
    exit 0 ;;
  Linux/x86_64|Linux/amd64) TARGET="linux-x64"; KIND="gemlite" ;;
  *) echo "build-bonsai-engine : plateforme non gérée ($HOST_OS/$HOST_ARCH), rien à faire." >&2; exit 0 ;;
esac
OUT="$OUT_ROOT/$TARGET"

command -v uv >/dev/null || { echo "uv est requis (curl -LsSf https://astral.sh/uv/install.sh | sh)" >&2; exit 1; }
command -v git >/dev/null || { echo "git est requis" >&2; exit 1; }

# ── 1. Sources officielles (dépôt de démo + vendor/) ───────────────────────
clone_if_missing() {
  local url="$1" dest="$2"
  if [ ! -d "$dest/.git" ]; then
    echo "→ clone $url"
    git clone --quiet "$url" "$dest"
  fi
}
mkdir -p "$(dirname "$DEMO")"
clone_if_missing https://github.com/PrismML-Eng/Bonsai-Image-Demo.git "$DEMO"
mkdir -p "$DEMO/vendor"
clone_if_missing https://github.com/PrismML-Eng/image-studio.git "$DEMO/vendor/image-studio"
clone_if_missing https://github.com/PrismML-Eng/mflux-prism.git "$DEMO/vendor/mflux-prism"
# image-studio pointe mflux vers un git ; on l'installe depuis vendor/ nous-mêmes.
find "$DEMO" -type f \( -name '._*' -o -name '.DS_Store' \) -delete 2>/dev/null || true

# ── 2. CPython autonome ────────────────────────────────────────────────────
# Le runtime est assemblé dans un dossier de travail sur un système de
# fichiers natif : python-build-standalone contient des liens symboliques, que
# le SSD exFAT du workspace refuse. Il est recopié (liens déréférencés) dans
# resources/ à la toute fin.
STAGE="${BONSAI_STAGE_DIR:-}"
if [ -z "$STAGE" ]; then
  if [ -d /Volumes/LiquidBuild ]; then STAGE="/Volumes/LiquidBuild/bonsai-engine-stage"
  elif [ "$(uname -s)" = "Linux" ]; then
    # Pas /tmp sur Linux : c'est souvent un tmpfs de quelques Go (ou soumis à
    # un quota), et le runtime avec torch en fait plus — d'où « Disk quota
    # exceeded » en pleine copie. Le cache utilisateur vit sur le vrai disque.
    STAGE="${XDG_CACHE_HOME:-$HOME/.cache}/lumen-bonsai-engine-stage"
  else STAGE="${TMPDIR:-/tmp}/lumen-bonsai-engine-stage"; fi
fi
mkdir -p "$STAGE"
# Même raison pour les fichiers temporaires d'uv/pip (compilation des sdist,
# gemlite 0.5.1 n'existe qu'en source) : hors de /tmp sur Linux.
if [ "$HOST_OS" = "Linux" ]; then
  export TMPDIR="${TMPDIR:-$STAGE/tmp}"
  mkdir -p "$TMPDIR"
fi
# Garde-fou : le runtime pèse plusieurs Go ; mieux vaut le dire avant qu'après.
STAGE_FREE_KB="$(df -Pk "$STAGE" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "${STAGE_FREE_KB:-}" ] && [ "$STAGE_FREE_KB" -lt $((12 * 1024 * 1024)) ]; then
  echo "⚠ Moins de 12 Go libres dans $STAGE ($((STAGE_FREE_KB / 1024 / 1024)) Go) : la build risque d'échouer." >&2
  echo "  Choisis un autre dossier de travail : BONSAI_STAGE_DIR=/chemin/avec/de/la/place $0" >&2
fi
FINAL_OUT="$OUT"
OUT="$STAGE/$TARGET"
rm -rf "$OUT"
mkdir -p "$OUT"
DIST="$OUT/.python-dist"
echo "→ Python $PYVER autonome (python-build-standalone)"
uv python install "$PYVER" --install-dir "$DIST" >/dev/null
INNER="$(find "$DIST" -maxdepth 1 -mindepth 1 -type d -name 'cpython-*' | head -1)"
[ -n "$INNER" ] || { echo "Python autonome introuvable sous $DIST" >&2; exit 1; }
mv "$INNER" "$OUT/python"
rm -rf "$DIST"
PY="$OUT/python/bin/python3"
[ -x "$PY" ] || { echo "Interpréteur absent : $PY" >&2; exit 1; }
PY_TAG="$("$PY" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
SITE="$("$PY" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
# uv marque ses interpréteurs « gérés » (PEP 668) ; celui-ci nous appartient.
rm -f "$OUT/python/lib/python$PY_TAG/EXTERNALLY-MANAGED"

# ── 3. Paquets ─────────────────────────────────────────────────────────────
SOURCE_VENV="${BONSAI_SOURCE_VENV:-}"
if [ -z "$SOURCE_VENV" ] && [ "$KIND" = "mlx" ]; then
  for cand in \
    "$HOME/Library/Application Support/com.lumen.app/bonsai-official-venv" \
    "$DEMO/.venv"; do
    if [ -x "$cand/bin/python" ] && "$cand/bin/python" -c 'import mlx.core' >/dev/null 2>&1; then
      SOURCE_VENV="$cand"; break
    fi
  done
fi

UV_PIP=(uv pip install --python "$PY" --no-progress)
# Versions ÉPINGLÉES sur le uv.lock du dépôt de démo (gemlite 0.5.1.post1, hqq
# 0.2.8.post1, torch 2.12, triton 3.7 ; `exclude-newer = 2026-05-15`). Le
# backend_gpu d'image-studio n'a pas suivi gemlite 0.6 : son chargeur affecte
# les poids par `gl.W_q = …` et attend qu'ils ne soient PAS des nn.Parameter ;
# avec 0.6 le moteur meurt au préchauffage (« cannot assign … as parameter
# 'W_q' » puis « missing non-gemlite state_dict keys »). Sans le --exclude-newer
# du setup.sh officiel, uv prenait le gemlite du jour.
GEMLITE_PIN="${BONSAI_GEMLITE:-gemlite==0.5.1.post1}"
HQQ_PIN="${BONSAI_HQQ:-hqq==0.2.8.post1}"
PKG_CUTOFF="${BONSAI_PKG_CUTOFF:-2026-05-15T07:00:00Z}"
if [ -n "$SOURCE_VENV" ]; then
  SRC_TAG="$("$SOURCE_VENV/bin/python" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
  if [ "$SRC_TAG" != "$PY_TAG" ]; then
    echo "Le venv source est en Python $SRC_TAG, le runtime en $PY_TAG : relancer avec BONSAI_PYTHON=$SRC_TAG." >&2
    exit 1
  fi
  SRC_SITE="$("$SOURCE_VENV/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
  echo "→ Réutilisation du moteur déjà construit : $SRC_SITE"
  # Les .pth d'installations éditables pointent vers des chemins du poste de
  # build : on ne les copie pas, mflux/image-studio sont réinstallés juste après.
  rsync -a --exclude '__pycache__' --exclude '*.pth' --exclude '_*.pth' \
    --exclude 'nodejs_wheel*' --exclude 'twine*' --exclude 'pip' --exclude 'pip-*' \
    "$SRC_SITE/" "$SITE/"
  # Un `.pth` de venv (ex. `_virtualenv.pth`) n'a rien à faire ici.
  find "$SITE" -maxdepth 1 -name '*.pth' -delete 2>/dev/null || true
  "${UV_PIP[@]}" --no-deps --reinstall "$DEMO/vendor/mflux-prism" "$DEMO/vendor/image-studio"
  "${UV_PIP[@]}" huggingface_hub hf-transfer
else
  echo "→ Installation depuis les sources (le fork MLX se compile : Metal Toolchain requis)"
  if [ "$KIND" = "mlx" ]; then
    "${UV_PIP[@]}" \
      "mlx @ git+https://github.com/PrismML-Eng/mlx.git@$MLX_REV" \
      "$DEMO/vendor/mflux-prism" "$DEMO/vendor/image-studio" \
      huggingface_hub hf-transfer
  else
    # Linux + CUDA : gemlite/HQQ (Triton) et le backend GPU d'image-studio.
    "${UV_PIP[@]}" --exclude-newer "$PKG_CUTOFF" \
      "$DEMO/vendor/image-studio/backend_gpu" "$GEMLITE_PIN" "$HQQ_PIN" huggingface_hub hf-transfer
  fi
fi

# ── 3b. Régime : ce que le chemin Bonsai n'utilise jamais ─────────────────
# mflux tire PyTorch (400 Mo, seulement pour les poids .pt), OpenCV (117 Mo,
# ControlNet), matplotlib/sympy/networkx… : aucun ne sert à Bonsai sur MLX.
# lumen_bonsai_server.py pose un `torch` factice pour satisfaire les imports.
# Le runtime passe ainsi d'environ 1 Go à ~350 Mo.
if [ "$KIND" = "mlx" ] && [ "${BONSAI_SLIM:-1}" = "1" ]; then
  echo "→ Allègement (torch, opencv, matplotlib, sympy, networkx, twine, pip…)"
  uv pip uninstall --python "$PY" \
    torch opencv-python opencv-python-headless matplotlib sympy networkx mpmath \
    contourpy kiwisolver cycler pyparsing twine pip setuptools wheel \
    nodejs-wheel-binaries readme_renderer rfc3986 pkginfo id \
    >/dev/null 2>&1 || true
  # PyTorch factice (src-tauri/bonsai/torch_stub.py) : satisfait `import torch`
  # de mflux sans les 400 Mo ; sans dist-info, transformers le tient pour absent.
  rm -rf "$SITE/torch" "$SITE"/torch-*.dist-info "$SITE"/torchgen "$SITE"/functorch
  mkdir -p "$SITE/torch"
  cp "$ROOT/src-tauri/bonsai/torch_stub.py" "$SITE/torch/__init__.py"
fi

# ── 4. Serveur de Lumen, lanceur, métadonnées ──────────────────────────────
cp "$SERVER_SRC" "$OUT/lumen_bonsai_server.py"
cat > "$OUT/lumen-bonsai" <<'SH'
#!/usr/bin/env bash
# Lanceur de diagnostic : lumen-bonsai [--port 8800] (mêmes variables LUMEN_BONSAI_*)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONNOUSERSITE=1 PYTHONUNBUFFERED=1
unset PYTHONPATH PYTHONHOME
exec "$HERE/python/bin/python3" "$HERE/lumen_bonsai_server.py" "$@"
SH
chmod +x "$OUT/lumen-bonsai"
echo "$ENGINE_VERSION" > "$OUT/VERSION"
cp "$DEMO/LICENSE.txt" "$OUT/Bonsai-Image-Demo-LICENSE.txt" 2>/dev/null || true
cp "$DEMO/vendor/mflux-prism/LICENSE" "$OUT/mflux-LICENSE.txt" 2>/dev/null || true

# ── 5. Allègement : caches, tests, symboles inutiles ───────────────────────
find "$OUT/python" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$OUT/python/lib/python$PY_TAG/test" "$OUT/python/lib/python$PY_TAG/idlelib" "$OUT/python/lib/python$PY_TAG/tkinter" 2>/dev/null || true
find "$OUT" -type f \( -name '._*' -o -name '.DS_Store' \) -delete 2>/dev/null || true

# ── 6. Signature ad hoc (macOS) : un dylib non signé est refusé au chargement
#      dans une app signée ; le bundler Tauri re-signe ensuite avec l'identité. ─
if [ "$HOST_OS" = "Darwin" ]; then
  echo "→ Signature ad hoc des binaires Python"
  find "$OUT/python" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0 \
    | xargs -0 -n 50 codesign --force --sign - >/dev/null 2>&1 || true
fi

# ── 7. Sonde : les imports doivent passer depuis le runtime seul ───────────
if [ "${BONSAI_SKIP_PROBE:-0}" != "1" ]; then
  echo "→ Sonde d'import"
  ( cd "$OUT" && env -u PYTHONPATH -u PYTHONHOME PYTHONNOUSERSITE=1 \
      LUMEN_BONSAI_KIND="$KIND" LUMEN_BONSAI_MODELS_DIR="$OUT" \
      "$PY" lumen_bonsai_server.py --probe )
fi

# ── 8. Archive téléchargeable + manifeste ─────────────────────────────────
# Le moteur n'est PAS embarqué dans l'app : Lumen le télécharge à la demande
# (Catalogue → Modèles → Image) depuis une Release GitHub, d'après le manifeste
# `bonsai-engine.json` servi par le dépôt lumen-apps (GitHub Pages). Voir
# scripts/publish-bonsai-engine.sh pour la publication.
DIST="$ROOT/dist/bonsai-engine"
mkdir -p "$DIST"
ZIP_NAME="lumen-bonsai-engine-$TARGET-$ENGINE_VERSION.zip"
ZIP="$DIST/$ZIP_NAME"
rm -f "$ZIP"
echo "→ Archive $ZIP_NAME"
# Liens déréférencés (-y absent) : `zip` suit les liens et stocke le fichier
# visé — le runtime est ensuite dézippé par Lumen, éventuellement sur un
# système sans liens symboliques. Directement depuis le dossier de travail :
# l'ancienne copie « à plat » intermédiaire doublait l'espace nécessaire.
( cd "$STAGE" && zip -r -q -X "$ZIP" "$TARGET" )
node "$ROOT/scripts/bonsai-engine-manifest.mjs" "$TARGET" "$ZIP" "$ENGINE_VERSION"

# ── 9. Copie de développement dans resources/ (jamais embarquée) ──────────
# `engine_dir()` (bonsai.rs) la trouve en build debug : pratique pour tester
# sans télécharger. tauri.conf.json ne liste plus resources/bonsai.
if [ "${BONSAI_DEV_COPY:-1}" = "1" ]; then
  echo "→ Copie de développement vers $FINAL_OUT"
  rm -rf "$FINAL_OUT"
  mkdir -p "$FINAL_OUT"
  rsync -rLptD --delete "$OUT/" "$FINAL_OUT/"
  find "$FINAL_OUT" -type f \( -name '._*' -o -name '.DS_Store' \) -delete 2>/dev/null || true
fi
du -sh "$ZIP" | { read -r size _; echo "✓ moteur Bonsai $size → $ZIP"; }
