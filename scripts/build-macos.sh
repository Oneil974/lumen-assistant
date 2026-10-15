#!/bin/bash
# Build « Lumen macOS » — .app + .dmg officiel, SANS dépendre du Finder.
#
# LE PROBLÈME : le bundler DMG de Tauri (create-dmg) monte l'image puis demande
# au Finder, par AppleScript, de placer les icônes et de dimensionner la
# fenêtre. Si le terminal d'où part le build n'a pas l'autorisation
# « Automatisation → Finder », l'AppleScript est refusé :
#
#   execution error: Non autorisé à envoyer des évènements Apple à Finder. (-1743)
#   Error failed to bundle project error running bundle_dmg.sh
#
# Le .app est alors déjà construit — seule la mise en page cosmétique échoue —
# mais `tauri build` sort en erreur et abandonne une image de travail de ~400 Mo
# (`rw.*.dmg`) à chaque tentative. Cette autorisation s'accorde PAR APPLICATION
# APPELANTE : l'accorder à Terminal ne la donne ni à iTerm, ni à VS Code, ni à
# un agent.
#
# LA SOLUTION : `CI=true`. Le bundler passe alors `--skip-jenkins` à create-dmg,
# qui saute purement et simplement l'AppleScript. Le DMG reste celui du pipeline
# officiel — même nom, même emplacement, même contenu, c'est bien celui qu'on met
# en ligne ; seules les icônes ne sont pas repositionnées dans la fenêtre du
# volume. La valeur DOIT être exactement « true » (source du bundler :
# `if let Some(value) = env::var_os("CI") { if value == "true" { … } }`) ; `CI=1`
# est en outre refusé par le CLI, qui lit cette variable comme la valeur de son
# option `--ci`. `TAURI_BUNDLER_DMG_IGNORE_CI=true` désactive ce contournement :
# ne pas y toucher.
#
# LE DEUXIÈME PIÈGE : create-dmg tourne avec `bundle/macos` pour dossier
# courant, et `hdiutil convert` REFUSE d'écrire par-dessus un fichier existant
# (« convert failed - Le fichier existe »). Un DMG oublié là par un build
# précédent fait donc échouer tous les suivants — et Tauri, qui ne nettoie que
# `bundle/dmg`, ne le voit pas. D'où le déblayage ci-dessous.
#
#   ./scripts/build-macos.sh                         # la commande habituelle
#   npm run build:mac                                # idem
#   ./scripts/build-macos.sh --dmg-only              # refait le DMG seul (~10 s)
#   npm run build:mac:pro                            # édition Pro (« Lumen Pro.app »)
#
# DEUX ÉDITIONS, UN SEUL DOSSIER DE BUILD : les `.app` et les archives d'updater
# des deux éditions cohabitent sans problème dans `bundle/`, mais le bundler DMG
# de Tauri VIDE `bundle/dmg` à chaque passage — construire l'une y efface donc
# l'image de l'autre. D'où la copie systématique dans `dist/`, qui est le vrai
# dossier de livraison : les deux DMG y restent côte à côte.
# Pour des arbres de build complètement séparés (au prix d'une recompilation
# complète et d'une dizaine de Go), il suffit de viser un autre dossier :
#   CARGO_TARGET_DIR=/Volumes/LiquidBuild/liquid_agent_target-pro npm run build:mac:pro
#
# NB : plus de `-- --features atelier`. L'Atelier des agents est en sommeil et
# n'a plus d'entrée dans l'interface — l'activer ne l'afficherait pas.
#
# Rien à retenir de plus qu'un préfixe si tu préfères ta commande brute :
#   CI=true cargo tauri build
#
# Tout argument est transmis tel quel à `tauri build`. Pour une release,
# exporter la clé de signature AVANT (cf. scripts/release.mjs) :
#   TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.lumen/updater.key)" \
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" ./scripts/build-macos.sh
set -e

cd "$(dirname "$0")/.."

# Déblayage préalable : DMG oublié dans `bundle/macos` (bloque `hdiutil
# convert`), images de travail des tentatives ratées (~400 Mo pièce), et volumes
# restés montés — create-dmg n'en démonte aucun quand il échoue.
if [ -n "${TARGET_DIR_EARLY:-}" ] || true; then
  EARLY=$(sed -n 's/^[[:space:]]*target-dir[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' \
    src-tauri/.cargo/config.toml 2>/dev/null | head -1)
  EARLY="${CARGO_TARGET_DIR:-${EARLY:-src-tauri/target}}/release/bundle"
  if [ -d "$EARLY/macos" ]; then
    find "$EARLY/macos" -maxdepth 1 -name '*.dmg' -print -delete | sed 's/^/  déblayé : /'
  fi
  for v in /Volumes/dmg.*; do
    [ -d "$v" ] && echo "  démonte le volume orphelin $v" && hdiutil detach "$v" >/dev/null 2>&1 || true
  done
fi

# `CI` n'est lue QUE par le bundler DMG ici. On ne l'exporte pas globalement
# pour ne pas modifier le comportement d'autres outils de la chaîne.
#
# `cargo tauri` est le chemin utilisé au quotidien (c'est lui qui accepte les
# `-- --features …`) ; on retombe sur le CLI npm s'il n'est pas installé.
# Le code de sortie n'est PAS concluant à lui seul : sans clé de signature,
# `tauri build` produit bien tous les bundles puis se termine en erreur sur
# « A public key has been found, but no private key ». On juge donc sur le
# livrable — le DMG est-il là ? — et on ne relaie l'échec que s'il manque.
# `--dmg-only` : réempaqueter sans recompiler (utile après un déblayage, ou pour
# refaire l'image à partir du .app déjà produit). ~10 s au lieu de 2 min.
DMG_ONLY=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--dmg-only" ]; then DMG_ONLY=1; else ARGS+=("$arg"); fi
done

# Passerelle Apple Foundation Models (macOS 27) : compilée à chaque build pour
# que resources/applefm suive la source Swift. Sans SDK 27, le script passe
# son tour et la source « Apple Foundation Models » reste simplement absente.
if [ "$DMG_ONLY" -eq 0 ]; then
  bash "$(dirname "$0")/build-applefm.sh" || echo "⚠ Passerelle Apple FM non compilée (voir ci-dessus)."
  # Image Playground (macOS 27) : même logique, même repli silencieux.
  bash "$(dirname "$0")/build-imageplayground.sh" || echo "⚠ Passerelle Image Playground non compilée (voir ci-dessus)."
fi

# Build signé (scripts/build-macos-signed.sh) : Tauri ne signe que l'exécutable
# principal, or la notarisation refuse tout Mach-O non signé Developer ID dans
# le bundle. On signe donc les binaires de src-tauri/resources sur place, APRÈS
# la recompilation des passerelles Swift ci-dessus (qui écrase leur signature).
# Les fichiers ._* du X8 (exFAT) seraient recopiés dans le bundle et casseraient
# la signature : on les purge d'abord.
if [ "${LUMEN_SIGN_RESOURCES:-0}" = "1" ] && [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  find src-tauri/resources -name '._*' -delete 2>/dev/null || true
  while IFS= read -r f; do
    codesign --force --timestamp --options runtime --sign "$APPLE_SIGNING_IDENTITY" "$f" \
      && echo "  signé : $f"
  done < <(find src-tauri/resources -type f -exec sh -c 'file -b "$1" | grep -q Mach-O && echo "$1"' _ {} \;)
fi

set +e
if [ "$DMG_ONLY" -eq 1 ]; then
  CI=true cargo tauri bundle --bundles dmg "${ARGS[@]}"
elif command -v cargo-tauri >/dev/null 2>&1; then
  CI=true cargo tauri build "${ARGS[@]}"
else
  CI=true npm run tauri build -- "${ARGS[@]}"
fi
BUILD_RC=$?
set -e

# Où Cargo écrit : Lumen déporte sa cible sur un volume dédié via
# `src-tauri/.cargo/config.toml` (`build.target-dir`). Cette clé prime sur le
# défaut ; `CARGO_TARGET_DIR`, s'il est exporté, prime sur tout.
TARGET_DIR="${CARGO_TARGET_DIR:-}"
if [ -z "$TARGET_DIR" ]; then
  TARGET_DIR=$(sed -n 's/^[[:space:]]*target-dir[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' \
    src-tauri/.cargo/config.toml 2>/dev/null | head -1)
fi
TARGET_DIR="${TARGET_DIR:-src-tauri/target}"
BUNDLE="$TARGET_DIR/release/bundle"

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
case "$(uname -m)" in
  arm64) ARCH=aarch64 ;;
  x86_64) ARCH=x64 ;;
  *) ARCH=$(uname -m) ;;
esac
# Nom du produit : « Lumen », ou celui de la surcouche passée en `--config`
# (édition Pro → « Lumen Pro »). Le bundler nomme le DMG d'après lui, donc le
# chercher en dur ferait échouer un build Pro pourtant réussi.
CONFIG_OVERLAY=""
prev=""
for arg in "${ARGS[@]}"; do
  [ "$prev" = "--config" ] && CONFIG_OVERLAY="$arg"
  case "$arg" in --config=*) CONFIG_OVERLAY="${arg#--config=}" ;; esac
  prev="$arg"
done
PRODUCT=$(node -p "require('./src-tauri/tauri.conf.json').productName")
if [ -n "$CONFIG_OVERLAY" ] && [ -f "$CONFIG_OVERLAY" ]; then
  PRODUCT=$(node -p "require('$(cd "$(dirname "$CONFIG_OVERLAY")" && pwd)/$(basename "$CONFIG_OVERLAY")').productName || '$PRODUCT'")
fi

DMG="$BUNDLE/dmg/${PRODUCT}_${VERSION}_${ARCH}.dmg"

if [ ! -f "$DMG" ]; then
  # Repli : le bundler assainit parfois le nom (espaces, accents). On accepte
  # tout DMG de cette version et de cette architecture.
  FOUND=$(find "$BUNDLE/dmg" -maxdepth 1 -name "*_${VERSION}_${ARCH}.dmg" ! -name 'rw.*' 2>/dev/null | head -1)
  [ -n "$FOUND" ] && DMG="$FOUND"
fi

if [ ! -f "$DMG" ]; then
  echo "DMG introuvable après le build : $DMG (tauri build a rendu $BUILD_RC)" >&2
  exit 1
fi
if [ "$BUILD_RC" != "0" ]; then
  echo "ℹ Les bundles sont là, mais tauri build s'est terminé en erreur ($BUILD_RC)."
  echo "  Cause habituelle : TAURI_SIGNING_PRIVATE_KEY absente — sans elle, pas de"
  echo "  fichier .sig, et scripts/release.mjs refusera de publier."
fi

# Images de travail abandonnées par d'anciennes tentatives : ~400 Mo pièce.
LEFTOVERS=$(find "$BUNDLE/macos" "$BUNDLE/dmg" -maxdepth 1 -name 'rw.*.dmg' 2>/dev/null | wc -l | tr -d ' ')
if [ "$LEFTOVERS" != "0" ]; then
  echo "ℹ $LEFTOVERS image(s) de travail rw.*.dmg traînent dans $BUNDLE — à supprimer pour récupérer la place."
fi

echo "✓ DMG : $DMG"
ls -lh "$DMG"

# Le bundler VIDE `bundle/dmg` à chaque build : sans cette copie, construire
# l'édition standard efface le DMG Pro (et l'inverse), ce qui donne l'impression
# qu'« un build remplace l'autre ». `dist/` garde les deux côte à côte, nommés
# par édition.
mkdir -p dist
cp -f "$DMG" "dist/$(basename "$DMG")"
echo "✓ Copie conservée : dist/$(basename "$DMG")"
ls -lh dist/*.dmg 2>/dev/null | sed 's/^/  /'

