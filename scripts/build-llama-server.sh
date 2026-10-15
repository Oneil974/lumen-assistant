#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${LLAMA_CPP_VERSION:-$(tr -d '[:space:]' < "$ROOT/config/llama-cpp.version")}"
SRC="${LLAMA_CPP_SOURCE:-$ROOT/.localtarget/llama.cpp-$VERSION}"
OUT="$ROOT/src-tauri/resources/llama-server"
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"

if [ -n "${CMAKE_BIN:-}" ]; then
  : # Respecte un cmake explicitement fourni par l'appelant.
else
  CMAKE_BIN="$(command -v cmake || true)"
  # Sur Apple Silicon, /usr/local/bin/cmake peut être la version Intel de
  # Homebrew, alors que /opt/homebrew/bin/cmake est native arm64.
  if [ "$HOST_OS" = "Darwin" ] && [ "$HOST_ARCH" = "arm64" ] && [ -x /opt/homebrew/bin/cmake ]; then
    CMAKE_BIN="/opt/homebrew/bin/cmake"
  elif [ "$HOST_OS" = "Darwin" ] && [ "$HOST_ARCH" = "x86_64" ] && [ -x /usr/local/bin/cmake ]; then
    CMAKE_BIN="/usr/local/bin/cmake"
  fi
fi
[ -x "${CMAKE_BIN:-}" ] || { echo "cmake est requis" >&2; exit 1; }
command -v git >/dev/null || { echo "git est requis" >&2; exit 1; }

# macOS peut déposer des fichiers AppleDouble (._*) et .DS_Store dans un
# dossier copié depuis un volume HFS/APFS. llama.cpp utilise plusieurs GLOB
# CMake et tente alors de compiler ces fichiers binaires comme des sources
# C/C++, ce qui produit « source file is not valid UTF-8 ». Ils ne sont pas
# suivis par git, donc checkout ne les retire pas.
clean_macos_metadata() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  find "$dir" -type f \( -name '._*' -o -name '.DS_Store' \) -delete
}

case "$HOST_OS/$HOST_ARCH" in
  Darwin/arm64|Darwin/arm64e) TARGET="macos-arm64"; BACKEND="-DGGML_METAL=ON" ;;
  Darwin/x86_64) TARGET="macos-x64"; BACKEND="-DGGML_METAL=OFF" ;;
  # GGML_NATIVE=ON encode les extensions du processeur EXACT de la machine de
  # compilation. C'est le plus rapide quand on compile sur la machine cible —
  # le cas nominal d'une build Linux — mais un binaire ainsi produit meurt en
  # « Instruction illicite » sur un processeur plus ancien. Pour fabriquer une
  # AppImage destinée à une autre machine (typiquement le Steam Deck, Zen 2,
  # compilé depuis un poste plus récent), lancer la build avec LLAMA_NATIVE=0.
  Linux/aarch64|Linux/arm64) TARGET="linux-arm64"; BACKEND="-DGGML_NATIVE=${LLAMA_NATIVE:-1}" ;;
  Linux/x86_64|Linux/amd64) TARGET="linux-x64"; BACKEND="-DGGML_NATIVE=${LLAMA_NATIVE:-1}" ;;
  *) echo "Architecture non supportée automatiquement: $HOST_OS/$HOST_ARCH" >&2; exit 1 ;;
esac
BUILD_BASE="$SRC/build-lumen-$TARGET"

# `tauri build` relance ce script à CHAQUE build (beforeBuildCommand). Sans
# garde-fou, on refait tout le tour : fetch réseau, configure CMake et build de
# chaque variante (cpu, vulkan, cuda sur Linux) — même quand llama-server est
# déjà là, à la bonne version. Un tampon mémorise ce qui a été produit et avec
# quoi ; s'il correspond, on ne touche à rien. Ce qu'il encode : la version
# épinglée, la cible, les réglages LLAMA_* et la présence des chaînes d'outils
# GPU (installer CUDA ou glslc APRÈS coup change la clé et relance la build).
# LLAMA_FORCE_BUILD=1 passe outre.
has_tool() { [ -x "$(command -v "$1" || true)" ] && echo 1 || echo 0; }
STAMP="$OUT/$TARGET/.build-stamp"
STAMP_KEY="$VERSION $TARGET native=${LLAMA_NATIVE:-1} cuda=${LLAMA_CUDA:-1} vulkan=${LLAMA_VULKAN:-auto}"
if [ "$HOST_OS" = "Linux" ]; then
  # Toute la détection des chaînes GPU se fait ICI, une seule fois, et entre
  # dans la clé du tampon. Elle servait auparavant à décider quelle variante
  # compiler, mais seuls nvcc et glslc étaient mémorisés : installer le loader
  # Vulkan, ses en-têtes ou le pilote NVIDIA après coup ne changeait pas la clé,
  # la build répondait « déjà construit » et la variante manquait toujours.
  LDCONFIG_BIN="$(command -v ldconfig || true)"
  # ldconfig vit dans /sbin, pas toujours présent dans le PATH d'un compte non
  # root ; le chemin direct sert de repli.
  [ -x "$LDCONFIG_BIN" ] || LDCONFIG_BIN=/sbin/ldconfig
  # Nom de bibliothèque EN CLAIR (pas de motif) : la sortie de ldconfig est
  # capturée puis testée — un `ldconfig -p | grep -q` sous `pipefail` peut
  # rendre faux quand grep referme le tube avant la fin (SIGPIPE), et un motif
  # avec antislashs passé entre guillemets à `ls` ne correspond à aucun fichier.
  # C'est ce qui faisait « libvulkan.so.1 introuvable » sur un poste où il est.
  has_shared_lib() {
    local cache=""
    if [ -x "$LDCONFIG_BIN" ]; then cache="$("$LDCONFIG_BIN" -p 2>/dev/null || true)"; fi
    case "$cache" in *"$1"*) return 0 ;; esac
    ls /usr/lib/*/"$1" /usr/lib/"$1" /usr/lib64/"$1" /usr/local/lib/"$1" >/dev/null 2>&1
  }
  NVCC_BIN="$(command -v nvcc || true)"
  # Le Toolkit s'installe hors PATH par défaut sur beaucoup de distributions.
  if [ ! -x "${NVCC_BIN:-}" ] && [ -x /usr/local/cuda/bin/nvcc ]; then NVCC_BIN=/usr/local/cuda/bin/nvcc; fi
  NVCC_PRESENT=0; [ -x "${NVCC_BIN:-}" ] && NVCC_PRESENT=1
  # Le pilote NVIDIA, distinct du Toolkit : c'est lui qui fournit libcuda.so.1,
  # contre laquelle tout binaire CUDA est lié dynamiquement.
  HAS_CUDA_DRIVER=0; has_shared_lib "libcuda.so.1" && HAS_CUDA_DRIVER=1
  GLSLC_BIN="$(command -v glslc || true)"
  HAS_GLSLC=0; [ -x "${GLSLC_BIN:-}" ] && HAS_GLSLC=1
  HAS_VULKAN_LOADER=0; has_shared_lib "libvulkan.so.1" && HAS_VULKAN_LOADER=1
  HAS_VULKAN_HEADERS=0; [ -f /usr/include/vulkan/vulkan.h ] && HAS_VULKAN_HEADERS=1
  STAMP_KEY="$STAMP_KEY nvcc=$NVCC_PRESENT cudadrv=$HAS_CUDA_DRIVER glslc=$HAS_GLSLC vkloader=$HAS_VULKAN_LOADER vkheaders=$HAS_VULKAN_HEADERS"
  echo "Chaînes détectées : nvcc=$NVCC_PRESENT pilote-nvidia=$HAS_CUDA_DRIVER glslc=$HAS_GLSLC vulkan-loader=$HAS_VULKAN_LOADER vulkan-headers=$HAS_VULKAN_HEADERS"
fi
# Les variantes que le tampon annonce doivent toutes être là : un sous-dossier
# effacé à la main (ou par une build interrompue) ne doit pas passer pour livré.
stamp_variants_present() {
  local v
  [ "$HOST_OS" = "Linux" ] || return 0
  for v in $(sed -n 2p "$STAMP" | tr ',' ' '); do
    [ -x "$OUT/$TARGET/$v/llama-server" ] || return 1
  done
}
if [ "${LLAMA_FORCE_BUILD:-0}" != "1" ] && [ -x "$OUT/$TARGET/llama-server" ] \
  && [ -f "$STAMP" ] && [ "$(sed -n 1p "$STAMP")" = "$STAMP_KEY" ] && stamp_variants_present; then
  echo "✓ llama-server $VERSION déjà construit → $OUT/$TARGET (variantes : $(sed -n 2p "$STAMP"))"
  echo "  (LLAMA_FORCE_BUILD=1 pour forcer la reconstruction)"
  exit 0
fi

if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$(dirname "$SRC")"
  git clone https://github.com/ggml-org/llama.cpp.git "$SRC"
fi
if ! git -C "$SRC" fetch --tags --quiet origin "$VERSION" 2>/dev/null; then
  echo "⚠ Impossible de mettre à jour llama.cpp depuis le réseau ; utilisation du clone local." >&2
fi
git -C "$SRC" checkout --quiet "$VERSION"
clean_macos_metadata "$SRC"
# Cargo/Tauri parcourt ses fichiers de permissions generes. Un AppleDouble dans
# target est alors interprete comme du TOML et fait echouer le build en UTF-8.
clean_macos_metadata "$ROOT/src-tauri/target"

CMAKE_COMMON=(
  -DCMAKE_BUILD_TYPE=Release
  # Le binaire est distribue seul dans le bundle Tauri. Des bibliotheques
  # partagees conserveraient un RPATH vers le dossier CMake du poste de build.
  -DBUILD_SHARED_LIBS=OFF
  # Ne pas encoder les extensions du CPU exact de la machine de compilation :
  # le bundle doit fonctionner sur tous les Mac de la meme architecture.
  -DGGML_NATIVE=OFF
  -DLLAMA_BUILD_SERVER=ON
  -DLLAMA_BUILD_COMMON=ON
  -DLLAMA_BUILD_TESTS=OFF
  -DLLAMA_BUILD_EXAMPLES=OFF
  # Lumen consomme uniquement l'API ; ne pas embarquer l'UI Svelte de llama.cpp.
  -DLLAMA_BUILD_UI=OFF
  # Lumen ne sert llama.cpp que sur 127.0.0.1 en HTTP. Eviter OpenSSL supprime
  # aussi les dependances absolues vers une installation Homebrew locale.
  -DLLAMA_OPENSSL=OFF
)
if [ "$HOST_OS" = "Darwin" ]; then
  CMAKE_COMMON+=("-DCMAKE_OSX_ARCHITECTURES=$HOST_ARCH")
fi

# Parallélisme : tous les cœurs sur Linux (build native sur la machine cible,
# plusieurs variantes à enchaîner). macOS garde 2 : la compilation depuis un
# volume externe y est surtout limitée par le disque, et une valeur haute a déjà
# provoqué des AppleDouble en rafale sur exFAT.
if [ "$HOST_OS" = "Linux" ]; then JOBS="$(nproc 2>/dev/null || echo 4)"; else JOBS=2; fi

# Configure et compile une variante. Le nom vide produit le répertoire de build
# historique (macOS, une seule variante) ; un nom le suffixe (Linux : « cpu »,
# « cuda »). Renseigne BIN avec l'exécutable produit.
build_variant() {
  local name="$1"; shift
  local build="$BUILD_BASE${name:+-$name}"
  clean_macos_metadata "$build"
  # Un répertoire de build peut avoir été configuré sous Rosetta puis réutilisé
  # nativement (ou inversement). Dans ce cas, repartir d'un cache généré est
  # nécessaire pour éviter de mélanger des bibliothèques x86_64 et arm64.
  if [ "$HOST_OS" = "Darwin" ] && [ -f "$build/CMakeCache.txt" ] \
    && ! grep -q "^CMAKE_OSX_ARCHITECTURES:STRING=$HOST_ARCH$" "$build/CMakeCache.txt"; then
    echo "⚠ Cache CMake d'architecture différente : régénération de $build"
    rm -rf "$build"
  fi
  # Une configuration ratée laisse un cache CMake à moitié écrit (langage CUDA
  # marqué cassé, architectures mémorisées). Le relancer tel quel réechoue même
  # une fois la vraie cause corrigée : on repart proprement.
  if ! "$CMAKE_BIN" -S "$SRC" -B "$build" "${CMAKE_COMMON[@]}" "$BACKEND" "$@"; then
    rm -rf "$build"
    echo "configuration cmake (${name:-défaut}) en échec" >&2
    exit 1
  fi
  "$CMAKE_BIN" --build "$build" --config Release --target llama-server -j "${CMAKE_BUILD_PARALLEL_LEVEL:-$JOBS}"
  # La copie de fichiers sur un volume macOS peut recréer des AppleDouble
  # pendant la compilation ; on laisse l'arbre propre pour l'exécution suivante.
  clean_macos_metadata "$build"
  BIN="$build/bin/llama-server"; [ -x "$BIN" ] || BIN="$build/bin/Release/llama-server"
  [ -x "$BIN" ] || { echo "llama-server introuvable dans $build" >&2; exit 1; }
}

# Architectures GPU que nvcc de CETTE machine sait produire, parmi celles visées
# (Pascal 61 → Blackwell 120, dont Ampere 86 pour les RTX 30xx). Elles ne
# peuvent pas être codées en dur : chaque version majeure du Toolkit retire les
# plus anciennes (CUDA 13 a supprimé Pascal et Volta) et nvcc refuse alors de
# compiler quoi que ce soit.
cuda_architectures() {
  local wanted=" 61 70 75 80 86 89 120 " supported archs=""
  supported="$("$NVCC_BIN" --list-gpu-arch 2>/dev/null | sed -n 's/^compute_\([0-9]*\)$/\1/p')" || true
  for a in $supported; do
    case "$wanted" in *" $a "*) archs="${archs:+$archs;}$a" ;; esac
  done
  printf '%s' "$archs"
}

mkdir -p "$OUT/$TARGET"

if [ "$HOST_OS" = "Darwin" ]; then
  # macOS n'a qu'une variante (Metal) : binaire à plat, comme avant.
  build_variant ""
  DEST="$OUT/$TARGET/llama-server"
  install -m 755 "$BIN" "$DEST"
  # Un bundle macOS ne doit jamais fonctionner par accident grace au dossier de
  # compilation ou a Homebrew. Refuser le build plutot que livrer un executable
  # qui cessera de demarrer sur une autre machine ou sans le disque de travail.
  OTOOL_BIN="$(command -v otool || true)"
  [ -x "$OTOOL_BIN" ] || { echo "otool est requis pour verifier le bundle macOS" >&2; exit 1; }
  MACHO_INFO="$($OTOOL_BIN -L "$DEST")
$($OTOOL_BIN -l "$DEST")"
  BAD_REFERENCES="$(printf '%s\n' "$MACHO_INFO" \
    | grep -v -F "$DEST:" \
    | grep -E "/Volumes/|/opt/homebrew/|/usr/local/opt/|@rpath/(libllama|libggml|libmtmd)" || true)"
  if [ -n "$BAD_REFERENCES" ]; then
    echo "llama-server contient encore une dependance non portable :" >&2
    printf '%s\n' "$BAD_REFERENCES" >&2
    exit 1
  fi
  VARIANTS="metal"
else
  # Linux : même disposition que Windows — « cpu » toujours construit, « cuda »
  # en plus quand le Toolkit NVIDIA est là. Lumen choisit au démarrage.
  build_variant "cpu"
  mkdir -p "$OUT/$TARGET/cpu"
  install -m 755 "$BIN" "$OUT/$TARGET/cpu/llama-server"
  VARIANTS="cpu"

  # Variante Vulkan : le seul chemin GPU des machines AMD et Intel (dont le
  # Steam Deck), et un repli utile sur NVIDIA quand le CUDA Toolkit manque.
  # Elle demande le loader, les en-têtes et glslc (compilateur de shaders, paquet
  # `glslc` sur Debian/Ubuntu, `shaderc` sur Arch) : sans lui, la configuration
  # CMake échoue tard, sur un message qui ne nomme pas le paquet manquant.
  drop_stale_vulkan() { rm -rf "$OUT/$TARGET/vulkan"; }

  # Sur ARM64 (Raspberry Pi) : Vulkan coupé par défaut. Le GPU V3D n'apporte
  # rien face au CPU et la configuration échoue (SPIRV-Headers absent de
  # Bookworm). LLAMA_VULKAN=1 pour forcer l'essai.
  if [ "$TARGET" = "linux-arm64" ] && [ "${LLAMA_VULKAN:-0}" != "1" ]; then
    echo "linux-arm64 : variante Vulkan sautée (LLAMA_VULKAN=1 pour la forcer)."
    drop_stale_vulkan
  elif [ "${LLAMA_VULKAN:-1}" = "0" ]; then
    echo "LLAMA_VULKAN=0 : variante Vulkan sautée."
    drop_stale_vulkan
  elif [ "$HAS_VULKAN_LOADER" -eq 0 ]; then
    # Même piège que CUDA : linuxdeploy résout les dépendances du binaire pour
    # fabriquer l'AppImage. Sans libvulkan.so.1 ici, il échoue en toute fin de
    # build sur « Could not find dependency: libvulkan.so.1 », alors que le .deb
    # serait passé.
    echo "⚠ libvulkan.so.1 introuvable : variante Vulkan sautée." >&2
    echo "  Installe le loader (Debian/Ubuntu : libvulkan1 libvulkan-dev)." >&2
    drop_stale_vulkan
  elif [ "$HAS_VULKAN_HEADERS" -eq 0 ] || [ ! -x "${GLSLC_BIN:-}" ]; then
    echo "⚠ En-têtes Vulkan ou glslc absents : variante Vulkan sautée." >&2
    echo "  Debian/Ubuntu : sudo apt-get install libvulkan-dev glslc" >&2
    echo "  Ou lance la build avec LLAMA_VULKAN=0 pour assumer ce choix." >&2
    drop_stale_vulkan
  else
    build_variant "vulkan" -DGGML_VULKAN=ON
    mkdir -p "$OUT/$TARGET/vulkan"
    install -m 755 "$BIN" "$OUT/$TARGET/vulkan/llama-server"
    VARIANTS="$VARIANTS, vulkan"
  fi

  # Une variante CUDA laissée par une build précédente casserait l'AppImage de
  # la même façon, même si on ne la reconstruit pas maintenant.
  drop_stale_cuda() { rm -rf "$OUT/$TARGET/cuda"; }

  if [ "${LLAMA_CUDA:-1}" = "0" ]; then
    echo "LLAMA_CUDA=0 : variante CUDA sautée."
    drop_stale_cuda
  elif [ -x "${NVCC_BIN:-}" ] && [ "$HAS_CUDA_DRIVER" -eq 0 ]; then
    # Cas typique d'une VM ou d'un conteneur de build : Toolkit installé, aucune
    # carte exposée. Compiler quand même produirait un binaire impossible à
    # empaqueter et impossible à tester ici.
    echo "⚠ CUDA Toolkit présent mais pilote NVIDIA absent (pas de libcuda.so.1)." >&2
    echo "  Variante CUDA sautée : linuxdeploy ne pourrait pas empaqueter l'AppImage." >&2
    echo "  Compile sur une machine avec le pilote NVIDIA pour l'inclure." >&2
    drop_stale_cuda
  elif [ -x "${NVCC_BIN:-}" ]; then
    # Transmettre le nvcc qu'on a résolu nous-mêmes : CMake ne cherche que dans
    # le PATH, alors que le Toolkit s'installe dans /usr/local/cuda/bin sans y
    # être ajouté. Sans ça, CMake trouve les en-têtes CUDA, échoue sur le
    # compilateur (« No CMAKE_CUDA_COMPILER could be found ») et le message ne
    # dit nulle part que nvcc existe pourtant sur la machine.
    CUDA_ARGS=(-DGGML_CUDA=ON "-DCMAKE_CUDA_COMPILER=$NVCC_BIN")
    ARCHS="$(cuda_architectures)"
    if [ -n "$ARCHS" ]; then
      CUDA_ARGS+=("-DCMAKE_CUDA_ARCHITECTURES=$ARCHS")
      echo "CUDA : architectures compilées → ${ARCHS//;/, }"
    else
      echo "⚠ nvcc --list-gpu-arch illisible : architectures laissées au défaut de llama.cpp." >&2
    fi
    # Evite de dependre de libcudart.so, absente des machines sans Toolkit
    # (c'est-a-dire celles de tous les utilisateurs).
    CUDA_ARGS+=(-DCMAKE_CUDA_RUNTIME_LIBRARY=Static)
    # nvcc appelle ses propres outils (cicc, ptxas) ; les avoir dans le PATH
    # evite un echec tardif quand le Toolkit n'y a jamais ete ajoute.
    PATH="$(dirname "$NVCC_BIN"):$PATH"
    export PATH
    build_variant "cuda" "${CUDA_ARGS[@]}"
    mkdir -p "$OUT/$TARGET/cuda"
    install -m 755 "$BIN" "$OUT/$TARGET/cuda/llama-server"
    VARIANTS="${VARIANTS/cpu/cpu, cuda}"
  elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
    # Une carte répond mais le Toolkit manque : c'est le cas piégeux. Sans
    # erreur franche, la build réussit et Lumen tourne sur le processeur en
    # silence — ce qui ne se remarque qu'à l'usage.
    echo "Une carte NVIDIA répond mais nvcc est introuvable : la variante CUDA" >&2
    echo "ne peut pas être compilée et Lumen tournerait sur le processeur." >&2
    echo "  - Installe le CUDA Toolkit NVIDIA, puis relance la build." >&2
    echo "  - Ou lance la build avec LLAMA_CUDA=0 pour assumer une version CPU seule." >&2
    exit 1
  else
    echo "nvcc introuvable et aucune carte NVIDIA détectée : variante CPU seule."
    drop_stale_cuda
  fi

  # Le binaire à plat reste écrit pour rester lisible par une version de Lumen
  # antérieure au choix de backend (elle ne connaît pas les sous-dossiers).
  install -m 755 "$OUT/$TARGET/cpu/llama-server" "$OUT/$TARGET/llama-server"
fi

cp "$SRC/LICENSE" "$OUT/$TARGET/llama.cpp-LICENSE.txt"
printf '%s\n' "$VERSION" > "$OUT/$TARGET/VERSION"
printf '%s\n%s\n' "$STAMP_KEY" "$VARIANTS" > "$STAMP"
# install/cp peuvent recreer des AppleDouble en ecrivant sur le volume exFAT.
# Nettoyer apres la derniere copie pour ne pas les embarquer dans Lumen.app.
clean_macos_metadata "$OUT/$TARGET"
echo "✓ llama-server $VERSION → $OUT/$TARGET (variantes : $VARIANTS)"
