#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Démo côté PC : pousse l'état de l'orbe vers l'ESP32 (test sans Lumen OS).
#
#   python3 sender_demo.py <ip_esp32> [port]
#
# Fait défiler les thèmes, puis simule une "parole" avec un niveau audio animé.
# Sert de référence pour l'intégration Lumen OS (voir README, section "Pont").

import json
import math
import socket
import sys
import time

HOST = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.50"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8787


def main():
    s = socket.create_connection((HOST, PORT), timeout=5)
    send = lambda d: s.sendall((json.dumps(d) + "\n").encode())

    for theme in ("aurora", "violet", "ember", "ocean", "mono"):
        print("thème:", theme)
        send({"theme": theme, "mode": "idle"})
        time.sleep(2.5)

    print("simulation parole (mode speaking + niveau audio)…")
    send({"theme": "aurora", "mode": "speaking"})
    t0 = time.time()
    while time.time() - t0 < 8:
        # faux niveau audio : deux sinus superposés -> pulsation "vivante"
        t = time.time() - t0
        level = 0.5 + 0.4 * math.sin(t * 6) * abs(math.sin(t * 1.3))
        send({"level": round(level, 3)})
        time.sleep(0.033)  # ~30 Hz

    send({"mode": "idle"})
    s.close()


if __name__ == "__main__":
    main()
