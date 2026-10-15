#!/bin/bash
# Installe pigpio-lite (remplaçant de pigpiod pour Raspberry Pi 5) : démon lgpio +
# shim `pigs` compatible + service systemd. À exécuter SUR le Pi, en root.
#
#   sudo ./install.sh
#
# Ensuite, les blocs Raspberry Pi de Lumen/Fluxo fonctionnent tels quels.
set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "À lancer en root : sudo ./install.sh" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"

echo "→ Dépendance lgpio"
apt-get update -qq
apt-get install -y python3-lgpio

echo "→ Démon dans /opt/pigpio-lite"
install -d /opt/pigpio-lite
install -m 0755 "$HERE/pigpio_lite.py" /opt/pigpio-lite/pigpio_lite.py

echo "→ Shim pigs dans /usr/local/bin (prioritaire sur le vrai pigs s'il existe)"
install -m 0755 "$HERE/pigs" /usr/local/bin/pigs

echo "→ Service systemd"
install -m 0644 "$HERE/pigpio-lite.service" /etc/systemd/system/pigpio-lite.service
systemctl daemon-reload
systemctl enable --now pigpio-lite

echo
echo "✓ pigpio-lite installé et démarré."
echo "  Test : pigs m 17 w && pigs w 17 1 && pigs r 17"
echo "  Statut : systemctl status pigpio-lite"
