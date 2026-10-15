#!/usr/bin/env bash
# Publie le moteur Bonsai téléchargeable :
#   1. l'archive dist/bonsai-engine/*.zip dans la Release « bonsai-engine » de
#      Oneil974/lumen-app (asset remplacé s'il existe) ;
#   2. le manifeste bonsai-engine.json sur GitHub Pages via le clone lumen-apps
#      (../lumen-apps), comme publish-apps.sh.
#
#   npm run build:bonsai && npm run bonsai:publish
#
# Le manifeste étant multi-plateforme, relancer depuis chaque OS n'écrase que
# l'entrée de sa cible (bonsai-engine-manifest.mjs repart du manifeste publié).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="Oneil974/lumen-app"
TAG="bonsai-engine"
DIST="dist/bonsai-engine"
REPO_DIR="${LUMEN_APPS_REPO:-../lumen-apps}"
command -v gh >/dev/null || { echo "gh (GitHub CLI) est requis" >&2; exit 1; }
[ -f "$DIST/bonsai-engine.json" ] || { echo "Aucun manifeste : lance d'abord npm run build:bonsai" >&2; exit 1; }

if ! gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" -R "$REPO" --title "Moteur Bonsai Image" \
    --notes "Runtime du moteur d'image PrismML Bonsai Image 4B, téléchargé à la demande par Lumen (Catalogue → Modèles → Image). Une archive par plateforme ; le manifeste vit sur https://oneil974.github.io/lumen-apps/bonsai-engine.json."
fi
# Un manifeste PÉRIMÉ (archive reconstruite sans relancer l'étape manifeste,
# ou étape interrompue) ferait croire « déjà en ligne » à cause de l'empreinte
# de l'ancienne archive : on vérifie que la taille de chaque fichier présent
# ici est bien celle inscrite. Une empreinte complète coûterait 3 Go de lecture.
STALE="$(node -e '
  const fs = require("fs"), path = require("path");
  const dist = process.argv[2];
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const [t, e] of Object.entries(m.targets || {}))
    for (const p of (e.parts || [e])) {
      const f = path.join(dist, p.file);
      if (fs.existsSync(f) && fs.statSync(f).size !== p.size)
        console.log(`${t}: ${p.file} fait ${fs.statSync(f).size} octets, le manifeste dit ${p.size}`);
    }
' "$DIST/bonsai-engine.json" "$DIST")"
if [ -n "$STALE" ]; then
  echo "Manifeste périmé — relance : node scripts/bonsai-engine-manifest.mjs <cible> <archive.zip> <version>" >&2
  printf '  %s\n' "$STALE" >&2
  exit 1
fi

# On envoie ce que le manifeste référence et qui est présent ici : l'archive
# entière (`url`) ou ses tranches (`parts`, cf. bonsai-engine-manifest.mjs) —
# jamais l'archive de 3 Go elle-même, que GitHub refuse (limite 2 Gio par asset).
# Un asset déjà en ligne avec la même empreinte n'est pas renvoyé : GitHub
# expose le SHA-256 de chaque asset (`digest`), et le manifeste porte le nôtre.
# Sans cela, republier le manifeste seul coûtait 3 Go d'envoi.
REMOTE_DIGESTS="$(gh api "repos/$REPO/releases/tags/$TAG" -q '.assets[] | "\(.name) \(.digest)"' 2>/dev/null || true)"
node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const e of Object.values(m.targets || {}))
    for (const p of (e.parts || [e])) console.log(p.file, p.sha256 || "");
' "$DIST/bonsai-engine.json" | while read -r name sha; do
  [ -f "$DIST/$name" ] || continue
  if [ -n "$sha" ] && printf '%s\n' "$REMOTE_DIGESTS" | grep -qF "$name sha256:$sha"; then
    echo "= $name déjà en ligne (même empreinte)"
    continue
  fi
  echo "→ Envoi de $name"
  gh release upload "$TAG" "$DIST/$name" -R "$REPO" --clobber
done

# Les archives d'une cible que le manifeste ne référence plus (versions
# précédentes, ex. windows-x64-20260919 après la 20260920) sont retirées de la
# Release : chacune pèse ~3 Go et une vieille copie en ligne prête à confusion.
# Les cibles absentes du manifeste ne sont jamais touchées.
KEEP="$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const e of Object.values(m.targets || {}))
    for (const p of (e.parts || [e])) console.log(p.file);
' "$DIST/bonsai-engine.json")"
TARGETS="$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(Object.keys(m.targets || {}).join("\n"));
' "$DIST/bonsai-engine.json")"
gh api "repos/$REPO/releases/tags/$TAG" -q '.assets[].name' 2>/dev/null | while read -r name; do
  printf '%s\n' "$KEEP" | grep -qxF "$name" && continue
  for t in $TARGETS; do
    case "$name" in
      "lumen-bonsai-engine-$t-"*)
        echo "− $name (ancienne version, retirée de la Release)"
        gh release delete-asset "$TAG" "$name" -R "$REPO" -y
        ;;
    esac
  done
done

if [ -d "$REPO_DIR/.git" ]; then
  cp "$DIST/bonsai-engine.json" "$REPO_DIR/bonsai-engine.json"
  ( cd "$REPO_DIR" && git add bonsai-engine.json \
    && { git diff --cached --quiet || { git commit -q -m "Moteur Bonsai : manifeste $(date +%Y-%m-%d)"; git push -q origin main; }; } )
  echo "Publié : https://oneil974.github.io/lumen-apps/bonsai-engine.json"
else
  echo "Clone lumen-apps introuvable ($REPO_DIR) : copie bonsai-engine.json à la main sur GitHub Pages." >&2
fi
