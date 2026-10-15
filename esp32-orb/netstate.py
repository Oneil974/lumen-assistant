# -*- coding: utf-8 -*-
# Canal réseau bidirectionnel entre Lumen OS et l'orbe (asyncio, non-bloquant).
#
#   Lumen OS  --->  orbe : lignes JSON d'ÉTAT
#       {"theme":"aurora", "mode":"speaking", "level":0.7}
#       {"mode":"idle"}
#   orbe  --->  Lumen OS : lignes JSON de COMMANDE (ex. appui long)
#       {"cmd":"dictation"}
#
# L'ESP32 est serveur ; Lumen OS (ou le pont de test) se connecte en TCP.

try:
    import ujson as json
except ImportError:
    import json
import time

try:
    import uasyncio as asyncio
except ImportError:
    import asyncio


class NetState:
    def __init__(self, orb, port):
        self.orb = orb
        self.port = port
        self.writers = set()          # clients connectés (pour l'envoi sortant)
        self.last_seen = {}

    async def _on_client(self, reader, writer):
        self.writers.add(writer)
        self.last_seen[writer] = time.ticks_ms()
        self.orb.set_connected(True)
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                self.last_seen[writer] = time.ticks_ms()
                theme = msg.get("theme")
                mode = msg.get("mode")
                level = msg.get("level")
                if theme:
                    self.orb.set_theme(theme)
                if mode:
                    self.orb.mode = mode
                    if mode in ("speaking", "listening"):
                        self.orb.note_activity()   # Lumen parle/écoute -> réveille
                if level is not None:
                    try:
                        self.orb.level = float(level)
                    except (TypeError, ValueError):
                        pass
                if msg.get("notification") is not None:
                    n = msg.get("notification")
                    if isinstance(n, dict):
                        self.orb.notify(n.get("text"), n.get("count", 1), n.get("source"), n.get("success", True), n.get("timestamp", ""))
                    else:
                        self.orb.notify(n, msg.get("count", 1))
                    self.orb.note_activity()       # une notif réveille l'écran
                if msg.get("message") is not None:
                    self.orb.show_message(msg.get("message"))
                    self.orb.note_activity()
                if msg.get("agent") is not None:
                    a = msg.get("agent") or {}
                    self.orb.show_agent(a.get("active"), a.get("count"), a.get("task"), a.get("agent_id"))
                    self.orb.note_activity()
                if msg.get("connected") is not None:
                    self.orb.set_connected(msg.get("connected"))
                if msg.get("sensors") is not None:
                    self.orb.set_sensors(msg.get("sensors"))
                if msg.get("events") is not None:
                    self.orb.set_events(msg.get("events"))
                if msg.get("tasks") is not None:
                    self.orb.set_tasks(msg.get("tasks"))
                if msg.get("status") is not None:
                    self.orb.set_status(msg.get("status"))
                if msg.get("time") is not None:
                    self.orb.set_time(msg.get("time"), pushed=True)
                if msg.get("agenda") is not None:
                    a = msg.get("agenda")
                    if isinstance(a, dict):
                        self.orb.set_agenda(a.get("label"), a.get("time"))
                    else:
                        self.orb.set_agenda(a)
                if msg.get("ota") is not None:
                    try:
                        import ota
                        ota.handle(msg.get("ota"))
                    except Exception as e:
                        print("OTA:", e)
                if msg.get("wake"):
                    self.orb.note_activity()       # réveil explicite demandé
                if msg.get("cmd") == "reset":
                    import machine
                    await asyncio.sleep_ms(200)
                    machine.reset()
        except Exception:
            pass
        finally:
            self.writers.discard(writer)
            self.last_seen.pop(writer, None)
            self.orb.set_connected(bool(self.writers))
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def send(self, obj):
        # envoie une commande à tous les clients connectés
        if not self.writers:
            return
        data = (json.dumps(obj) + "\n").encode()
        for w in list(self.writers):
            try:
                w.write(data)
                await w.drain()
            except Exception:
                self.writers.discard(w)

    async def serve(self):
        await asyncio.start_server(self._on_client, "0.0.0.0", self.port)
        while True:
            now = time.ticks_ms()
            for w in list(self.writers):
                if time.ticks_diff(now, self.last_seen.get(w, now)) > 10000:
                    self.writers.discard(w)
                    self.last_seen.pop(w, None)
                    try:
                        w.close()
                        await w.wait_closed()
                    except Exception:
                        pass
            self.orb.set_connected(bool(self.writers))
            await asyncio.sleep(2)
