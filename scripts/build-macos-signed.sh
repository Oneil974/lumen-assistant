#!/bin/bash
# Build « Lumen macOS » SIGNÉ (Developer ID) + NOTARISÉ, prêt à distribuer.
#
#   npm run build:mac:signed
#
# Ce que fait le script :
#   1. trouve le certificat « Developer ID Application » dans le trousseau
#      (ou prend APPLE_SIGNING_IDENTITY s'il est exporté) ;
#   2. demande à build-macos.sh de signer les binaires embarqués
#      (src-tauri/resources : llama-server, passerelles Swift…) AVANT
#      l'empaquetage — Tauri ne signe que l'exécutable principal, et la
#      notarisation refuse tout Mach-O non signé dans le bundle ;
#   3. lance le build habituel (Tauri signe alors l'app avec le hardened
#      runtime + src-tauri/Entitlements.plist) ;
#   4. vérifie la signature, envoie le DMG au service de notarisation d'Apple,
#      agrafe le ticket sur le DMG et sur l'app, puis contrôle Gatekeeper.
#
# IDENTIFIANTS DE NOTARISATION — jamais dans le dépôt (il est public) : ils
# vivent dans le trousseau macOS sous un profil nommé, créé UNE fois avec :
#
#   xcrun notarytool store-credentials lumen-notary \
#       --apple-id <identifiant Apple> --team-id <TEAMID>
#   (le mot de passe d'app est demandé de façon masquée)
#
#   ou avec une clé API App Store Connect :
#   xcrun notarytool store-credentials lumen-notary \
#       --key ~/.appstoreconnect/AuthKey_XXXX.p8 --key-id XXXX --issuer <issuer>
#
# Tauri, lui, ne notarise pas ici : on lui retire volontairement APPLE_ID /
# APPLE_PASSWORD / APPLE_API_* pour que la notarisation passe par le profil du
# trousseau (un seul envoi, sur le DMG final).
#
# Options :
#   NOTARY_PROFILE=autre-profil npm run build:mac:signed
#   ./scripts/build-macos-signed.sh --skip-notarize   # signe seulement (test)
#   ./scripts/build-macos-signed.sh --no-build        # reprend à la vérification (app déjà construite)
#   Tout autre argument est transmis à build-macos.sh / tauri build.
set -euo pipefail

cd "$(dirname "$0")/.."

NOTARY_PROFILE="${NOTARY_PROFILE:-lumen-notary}"
SKIP_NOTARIZE=0
NO_BUILD=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    --no-build) NO_BUILD=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

# ── 1. Certificat ────────────────────────────────────────────────────────────
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning \
    | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)
fi
if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
  echo "✗ Aucun certificat « Developer ID Application » dans le trousseau." >&2
  echo "  Xcode › Réglages › Comptes › Manage Certificates › + › Developer ID Application" >&2
  exit 1
fi
export APPLE_SIGNING_IDENTITY
echo "✓ Certificat de signature trouvé dans le trousseau."

if [ "$SKIP_NOTARIZE" -eq 0 ]; then
  if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    echo "✗ Profil de notarisation « $NOTARY_PROFILE » absent ou invalide." >&2
    echo "  Crée-le une fois : xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id … --team-id …" >&2
    echo "  (ou relance avec --skip-notarize pour signer seulement)" >&2
    exit 1
  fi
  echo "✓ Profil de notarisation « $NOTARY_PROFILE » opérationnel."
fi

# Tauri notariserait lui-même s'il voyait ces variables : on centralise ici.
unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH || true

# ── 2 + 3. Build (build-macos.sh signe les ressources si LUMEN_SIGN_RESOURCES=1)
[ "$NO_BUILD" -eq 1 ] || LUMEN_SIGN_RESOURCES=1 bash scripts/build-macos.sh "${ARGS[@]+"${ARGS[@]}"}"

# ── Localiser les livrables ──────────────────────────────────────────────────
TARGET_DIR="${CARGO_TARGET_DIR:-}"
if [ -z "$TARGET_DIR" ]; then
  TARGET_DIR=$(sed -n 's/^[[:space:]]*target-dir[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' \
    src-tauri/.cargo/config.toml 2>/dev/null | head -1)
fi
TARGET_DIR="${TARGET_DIR:-src-tauri/target}"
BUNDLE="$TARGET_DIR/release/bundle"
PRODUCT=$(node -p "require('./src-tauri/tauri.conf.json').productName")
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
APP="$BUNDLE/macos/$PRODUCT.app"
DMG=$(ls -t dist/*_"${VERSION}"_*.dmg 2>/dev/null | head -1)
[ -d "$APP" ] || { echo "✗ App introuvable : $APP" >&2; exit 1; }
[ -f "$DMG" ] || { echo "✗ DMG introuvable dans dist/" >&2; exit 1; }

# ── 4. Vérifications de signature ────────────────────────────────────────────
echo "── Vérification de la signature"
codesign --verify --deep --strict --verbose=2 "$APP"
FLAGS=$(codesign -dv "$APP" 2>&1 | sed -n 's/.*flags=\(0x[0-9a-f]*([^)]*)\).*/\1/p')
case "$FLAGS" in *runtime*) ;; *) echo "✗ Hardened runtime absent ($FLAGS)" >&2; exit 1 ;; esac
case "$FLAGS" in *adhoc*) echo "✗ Signature ad-hoc : Tauri n'a pas utilisé le certificat" >&2; exit 1 ;; esac
ENT=$(codesign -d --entitlements - "$APP" 2>&1 || true)
[[ "$ENT" == *"device.audio-input"* ]] || { echo "✗ Entitlement micro absent de la signature" >&2; exit 1; }
# Chaque Mach-O embarqué doit porter la signature Developer ID.
while IFS= read -r f; do
  # Sortie capturée d'abord : avec pipefail, `codesign | grep -q` échoue quand
  # grep s'arrête avant la fin et que codesign reçoit SIGPIPE.
  SIG=$(codesign -dvv "$f" 2>&1 || true)
  if [[ "$SIG" != *"Authority=Developer ID Application"* ]]; then
    echo "✗ Binaire non signé Developer ID : $f" >&2; exit 1
  fi
done < <(find "$APP/Contents" -type f -perm -u+x -exec sh -c 'file -b "$1" | grep -q Mach-O && echo "$1"' _ {} \;)
echo "✓ App et binaires embarqués signés (hardened runtime, entitlements OK)."

# Le DMG lui-même doit être signé pour être notarisé proprement.
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"

if [ "$SKIP_NOTARIZE" -eq 1 ]; then
  echo "ℹ Notarisation sautée (--skip-notarize). DMG signé : $DMG"
  exit 0
fi

# ── 5. Notarisation + agrafage ───────────────────────────────────────────────
echo "── Envoi à la notarisation Apple (quelques minutes)…"
SUBMIT_OUT=$(xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1) || true
echo "$SUBMIT_OUT"
if ! echo "$SUBMIT_OUT" | grep -q "status: Accepted"; then
  SUB_ID=$(echo "$SUBMIT_OUT" | sed -n 's/^ *id: \([0-9a-f-]*\).*/\1/p' | head -1)
  echo "✗ Notarisation refusée. Détail :" >&2
  [ -n "$SUB_ID" ] && xcrun notarytool log "$SUB_ID" --keychain-profile "$NOTARY_PROFILE" >&2
  exit 1
fi

xcrun stapler staple "$DMG"
xcrun stapler staple "$APP"     # l'app du bundle (celle de l'archive d'updater)

echo "── Contrôle Gatekeeper"
spctl -a -vv -t install "$DMG"
spctl -a -vv "$APP"

echo "✓ Lumen $VERSION signé, notarisé et agrafé : $DMG"
