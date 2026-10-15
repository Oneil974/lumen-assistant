#!/usr/bin/env bash
# Publie le dépôt d'applications sur GitHub Pages (Oneil974/lumen-apps).
#
#   npm run apps:publish              # paquets + signature + push
#   npm run apps:publish -- "message" # message de commit personnalisé
#
# Le clone du dépôt vit à côté du projet (../lumen-apps). Village est exclu :
# 39 Mo d'assets, au-dessus de ce que Pages sert confortablement — il sera
# diffusé par une Release. `rsync --delete` fait foi : un paquet retiré de
# dist/apps disparaît aussi du dépôt.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_DIR="${LUMEN_APPS_REPO:-../lumen-apps}"
MSG="${1:-Mise à jour des paquets $(date +%Y-%m-%d)}"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "Clone introuvable : $REPO_DIR — git clone https://github.com/Oneil974/lumen-apps.git \"$REPO_DIR\"" >&2
  exit 1
fi

# Révisions : chaque paquet est comparé à la DERNIÈRE PUBLICATION (le clone) ;
# un fichier changé → version `<lumen>-r<n+1>` → Lumen propose la mise à jour.
node scripts/package-apps.mjs --exclude village --previous "$REPO_DIR/index.json"
node scripts/repo-sign.mjs dist/apps/index.json

# `bonsai-engine.json` vit dans le MÊME dépôt Pages mais est publié par
# publish-bonsai-engine.sh : sans l'exclure, `--delete` l'efface à chaque mise à
# jour des paquets et Lumen affiche « dépôt injoignable » pour le moteur.
rsync -a --delete --exclude .git --exclude .nojekyll --exclude README.md --exclude '._*' --exclude .DS_Store \
  --exclude bonsai-engine.json \
  dist/apps/ "$REPO_DIR/"

cd "$REPO_DIR"
git add -A
if git diff --cached --quiet; then
  echo "Rien à publier : le dépôt est déjà à jour."
  exit 0
fi
BUMPED=$(node -e 'const d=require("./index.json");const t=d.generated.slice(0,16);console.log(d.apps.filter(a=>a.updated&&a.updated.slice(0,16)>=t).map(a=>a.id+" "+a.version).join(", "))')
[ -n "$BUMPED" ] && MSG="$MSG — $BUMPED"
git commit -q -m "$MSG"
git push -q origin main
echo "Publié : https://oneil974.github.io/lumen-apps/index.json"
