# Vérifie la crypto Web Push de src-tauri/src/push.rs contre http_ece + pyjwt.
#   pip3 install http_ece cryptography pyjwt
#   cd src-tauri && LUMEN_PUSH_SAMPLE=/tmp/push.json cargo test --lib push::tests
#   python3 scripts/verify_push.py /tmp/push.json
import json, base64, sys, re
import http_ece, jwt
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization

def b64d(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
d = json.load(open(sys.argv[1]))

# 1. Déchiffrement aes128gcm avec la clé privée du "navigateur"
ua_priv = ec.derive_private_key(int.from_bytes(b64d(d["ua_private"]), "big"), ec.SECP256R1())
clear = http_ece.decrypt(b64d(d["body"]), private_key=ua_priv, auth_secret=b64d(d["auth"]), version="aes128gcm")
assert clear == d["plaintext"].encode(), clear
print("aes128gcm OK :", clear.decode())

# 2. Jeton VAPID : signature ES256 vérifiée avec la clé publique annoncée dans k=
m = re.match(r"vapid t=(\S+), k=(\S+)", d["authorization"])
t, k = m.groups()
assert k == d["vapid_public"], "k != clé publique"
pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b64d(k))
pem = pub.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
claims = jwt.decode(t, pem, algorithms=["ES256"], audience="https://web.push.apple.com")
print("VAPID OK :", claims)
