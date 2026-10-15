# -*- coding: utf-8 -*-
# OTA WiFi léger : Lumen pousse les fichiers .py de l'orbe par morceaux via le
# canal TCP existant, puis demande un reset. Pas de flash du .bin (plus risqué) :
# on remplace les scripts MicroPython, ce qui suffit à faire évoluer l'orbe.
#
# Protocole (lignes JSON, voir netstate.py) :
#   {"ota":{"name":"orb.py","seq":0,"b64":"...","final":false}}
#   {"ota":{"name":"orb.py","seq":1,"b64":"...","final":true}}
#   ...répéter pour chaque fichier...
#   {"cmd":"reset"}
#
# Écriture atomique : on écrit dans <name>.new puis on renomme -> une coupure
# en cours ne corrompt pas le fichier existant.

import os

try:
    import ubinascii as binascii
except ImportError:
    import binascii

_buffers = {}   # name -> bytes accumulés


def handle(chunk):
    """Traite un morceau OTA. Renvoie le nom du fichier écrit si terminé."""
    if not isinstance(chunk, dict):
        return None
    name = chunk.get("name")
    if not name or "/" in name or name.startswith("."):
        return None                      # garde-fou : pas de chemin arbitraire
    seq = int(chunk.get("seq", 0))
    if seq == 0:
        _buffers[name] = b""
    try:
        _buffers[name] = _buffers.get(name, b"") + binascii.a2b_base64(chunk.get("b64", ""))
    except Exception:
        _buffers.pop(name, None)
        return None
    if not chunk.get("final"):
        return None

    data = _buffers.pop(name, b"")
    tmp = name + ".new"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        try:
            os.remove(name)
        except OSError:
            pass
        os.rename(tmp, name)
        print("OTA: %s écrit (%d o)" % (name, len(data)))
        return name
    except Exception as e:
        print("OTA: échec", name, e)
        try:
            os.remove(tmp)
        except OSError:
            pass
        return None
