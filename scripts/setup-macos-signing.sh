#!/usr/bin/env bash
# Donne à Lumen une IDENTITÉ DE SIGNATURE STABLE sur cette machine.
#
# Pourquoi c'est nécessaire
# -------------------------
# Sans certificat, `tauri build` produit une signature « ad-hoc » posée par le
# linker. L'exigence désignée du bundle est alors :
#
#     designated => cdhash H"ecc6d4ef…"
#
# autrement dit : « cette app EST ce hash de binaire ». Chaque recompilation
# change le hash, donc change l'app aux yeux de macOS. Toutes les autorisations
# accordées (Enregistrement de l'écran, Micro, Accessibilité…) deviennent
# caduques d'un build à l'autre, alors que l'entrée reste affichée et cochée
# dans Réglages Système — d'où le « il redemande alors que c'est déjà activé ».
#
# Avec un certificat, même auto-signé, l'exigence devient :
#
#     designated => identifier "com.lumen.app" and certificate leaf = H"…"
#
# qui ne dépend plus du binaire : les autorisations survivent aux rebuilds.
#
# Ce script ne signe rien et ne modifie aucun réglage système : il crée le
# certificat dans VOTRE trousseau de session (pas de sudo) et affiche la
# commande de build à utiliser ensuite.
#
# Pour la DISTRIBUTION, ce certificat ne suffit pas : il faut un « Developer ID
# Application » Apple, plus la notarisation. Voir docs/release.md.

set -euo pipefail

NAME="${1:-Lumen Local Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Identité demandée : $NAME"

if security find-identity -v -p codesigning | grep -q "$NAME"; then
  echo "✔ Cette identité existe déjà dans le trousseau. Rien à faire."
  echo
  echo "Pour l'utiliser :"
  echo "  export APPLE_SIGNING_IDENTITY=\"$NAME\""
  exit 0
fi

echo "1/4  Création de la clé et du certificat auto-signé (10 ans)…"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$WORK/lumen.key" -out "$WORK/lumen.crt" \
  -subj "/CN=$NAME/O=Lumen/C=FR" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

echo "2/4  Empaquetage en PKCS#12…"
# OpenSSL 3 chiffre le PKCS#12 en AES + MAC SHA-256 : le trousseau macOS le
# rejette (« MAC verification failed… wrong password? »). On force les
# algorithmes historiques qu'il comprend, avec un mot de passe NON vide (un
# mot de passe vide échoue lui aussi à la vérification MAC).
P12_PASS="lumen-$$"
LEGACY=""
openssl pkcs12 -help 2>&1 | grep -q -- "-legacy" && LEGACY="-legacy"
openssl pkcs12 -export $LEGACY -inkey "$WORK/lumen.key" -in "$WORK/lumen.crt" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -out "$WORK/lumen.p12" -passout "pass:$P12_PASS" -name "$NAME" >/dev/null 2>&1 \
  || openssl pkcs12 -export -inkey "$WORK/lumen.key" -in "$WORK/lumen.crt" \
       -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
       -out "$WORK/lumen.p12" -passout "pass:$P12_PASS" -name "$NAME"

echo "3/4  Import dans le trousseau de session…"
# -T /usr/bin/codesign : autorise codesign à utiliser la clé sans redemander le
# mot de passe à chaque signature.
security import "$WORK/lumen.p12" -k "$KEYCHAIN" -P "$P12_PASS" -T /usr/bin/codesign >/dev/null

echo "4/4  Marquage du certificat comme fiable pour la signature de code…"
echo "     (macOS va demander votre mot de passe de session — aucun sudo, la"
echo "      confiance reste limitée à votre compte utilisateur.)"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/lumen.crt"

echo
if security find-identity -v -p codesigning | grep -q "$NAME"; then
  echo "✔ Identité disponible."
else
  echo "✘ L'identité n'apparaît pas dans « security find-identity -v -p codesigning »."
  echo "  Ouvrez Trousseaux d'accès, cherchez « $NAME », et passez la confiance"
  echo "  « Signature de code » sur « Toujours approuver »."
  exit 1
fi

cat <<EOF

Étapes suivantes
----------------
1. Construire en signant avec cette identité :

     APPLE_SIGNING_IDENTITY="$NAME" npm run tauri build

   Vérifier ensuite que l'exigence désignée ne dépend plus du binaire :

     codesign -d -r- "<chemin>/Lumen.app"
     # doit afficher : identifier "com.lumen.app" and certificate leaf = H"…"
     # et NON : cdhash H"…"

2. Purger l'autorisation périmée, une seule fois :

     tccutil reset ScreenCapture com.lumen.app

   Puis, dans Réglages Système → Confidentialité et sécurité →
   Enregistrement de l'écran, retirer toute entrée « Lumen » résiduelle avec le
   bouton « − » avant de relancer l'application.

3. Relancer Lumen : la demande d'autorisation réapparaît UNE fois, et tient
   ensuite d'un build à l'autre.
EOF
