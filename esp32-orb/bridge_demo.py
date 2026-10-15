#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Pont de TEST côté Mac : simule Lumen OS pour valider le canal bidirectionnel.
#
#   python3 bridge_demo.py <ip_esp32> [port]
#
# - Se connecte à l'orbe (serveur TCP sur l'ESP32).
# - Reçoit les COMMANDES de l'orbe (ex. {"cmd":"dictation"} sur appui long) et,
#   en réponse, simule une dictée : mode "listening" puis "speaking" avec un
#   niveau audio animé, puis retour "idle" -> l'orbe réagit en temps réel.
# - Tu peux aussi taper au clavier : 1=aurora 2=violet 3=ember 4=ocean 5=mono,
#   s=speaking  l=listening  i=idle  q=quitter.
#
# C'est la référence pour l'intégration réelle : côté Lumen OS, remplace la
# simulation par le vrai déclenchement de la dictée + le push de l'AnalyserNode.

import json
import math
import socket
import sys
import threading
import time

HOST = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.50"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8787

sock = socket.create_connection((HOST, PORT), timeout=5)
sock.settimeout(None)          # bloquant : on attend les commandes sans timeout
lock = threading.Lock()


def send(d):
    with lock:
        sock.sendall((json.dumps(d) + "\n").encode())


def fake_dictation():
    print("… dictée simulée (listening -> speaking -> idle)")
    send({"mode": "listening"})
    time.sleep(1.2)
    send({"mode": "speaking"})
    t0 = time.time()
    while time.time() - t0 < 5:
        t = time.time() - t0
        level = 0.5 + 0.4 * math.sin(t * 6) * abs(math.sin(t * 1.3))
        send({"level": round(level, 3)})
        time.sleep(0.033)
    send({"mode": "idle"})


def reader():
    buf = b""
    while True:
        data = sock.recv(256)
        if not data:
            break
        buf += data
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            try:
                msg = json.loads(line)
            except Exception:
                continue
            print("<- orbe:", msg)
            if msg.get("cmd") == "dictation":
                threading.Thread(target=fake_dictation, daemon=True).start()


threading.Thread(target=reader, daemon=True).start()
print("Connecté à %s:%d — appui long sur l'orbe = dictée simulée." % (HOST, PORT))
print("Clavier : 1-5 thèmes, s/l/i modes, q quitter.")

THEMES = {"1": "aurora", "2": "violet", "3": "ember", "4": "ocean", "5": "mono"}
try:
    while True:
        k = input().strip()
        if k == "q":
            break
        elif k in THEMES:
            send({"theme": THEMES[k]})
        elif k == "s":
            send({"mode": "speaking", "level": 0.7})
        elif k == "l":
            send({"mode": "listening"})
        elif k == "i":
            send({"mode": "idle"})
except (KeyboardInterrupt, EOFError):
    pass
finally:
    sock.close()
