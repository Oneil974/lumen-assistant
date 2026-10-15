"""Pont TCP JSON ligne par ligne avec Lumen Desktop."""
try:
    import ujson as json
except ImportError:
    import json
try:
    import uasyncio as asyncio
except ImportError:
    import asyncio
import time


class State:
    def __init__(self, cfg):
        # Catalogue vivant de la molette. Les valeurs de config.py ne sont
        # qu'un repli utilisé tant que l'application n'a rien poussé: elle
        # seule connaît les modèles réellement installés.
        self.models = dict((k, tuple(v)) for k, v in cfg.MODELS.items())
        self.backend = cfg.BACKENDS[0]
        self.model = (self.models.get(self.backend) or ("--",))[0]
        # Position de la molette dans le catalogue, conservée même si le nom
        # renvoyé par l'application n'y figure pas exactement.
        self.model_index = 0
        # Voix de synthèse. La liste vient de Lumen (tts_catalog): le firmware
        # n'a aucun moyen de la deviner, elle reste donc vide au démarrage.
        self.voices = ()
        self.voice = ""
        # Mode de discussion et fonction active de la molette.
        self.chat_mode = (getattr(cfg, "CHAT_MODES", ("chat",)) or ("chat",))[0]
        self.encoder_fn = (getattr(cfg, "ENCODER_FUNCTIONS", ("model",)) or ("model",))[0]
        self.led_color = ""
        # Notifications lumineuses. `notify_seq` est incrémenté à chaque
        # notification reçue: la boucle principale, seule à tenir l'objet
        # Leds, compare ce compteur au sien et déclenche le pulse. Un simple
        # booléen aurait fusionné deux notifications rapprochées.
        self.notify_seq = 0
        self.notify_color = ""
        self.notify_text = ""
        # Débit de la dernière réponse, en tokens/s. 0 = pas encore mesuré.
        self.tps = 0.0
        # Occupation du contexte, en jetons. 0 = inconnu (rien à afficher).
        self.ctx_used = 0
        self.ctx_total = 0
        self.volume = 50
        # Lecteur RFID: badge posé ou non, et mode association demandé par
        # Lumen (le seul cas où un badge immobile est réémis).
        self.rfid_present = False
        self.rfid_pairing = False
        self.desktop = False
        self.paused = False
        self.mode = "ready"
        self.connected = False
        self.ip = "0.0.0.0"


class Link:
    def __init__(self, state, port, max_models=32):
        self.state, self.port, self.clients = state, port, set()
        # Plafond du catalogue. Le Pico W lit la ligne JSON entière en
        # RAM: au-delà, on tronque plutôt que de risquer un MemoryError.
        self.max_models = max_models

    def snapshot(self):
        s = self.state
        return {"type": "controller_state", "backend": s.backend, "model": s.model,
                "volume": s.volume, "desktop": s.desktop, "paused": s.paused,
                "mode": s.mode, "ip": s.ip, "chat_mode": s.chat_mode,
                "voice": s.voice, "encoder_fn": s.encoder_fn,
                "rfid_present": s.rfid_present}

    async def send(self, obj):
        data = (json.dumps(obj) + "\n").encode()
        for writer in list(self.clients):
            try:
                writer.write(data)
                await writer.drain()
            except Exception:
                self.clients.discard(writer)

    async def _client(self, reader, writer):
        self.clients.add(writer)
        self.state.connected = True
        await self.send({"type": "hello", "protocol": 2, "capabilities": [
            "backend", "model", "hid_volume", "display",
            "chat_mode", "voice", "leds",
            # Pulse coloré du bandeau à l'arrivée d'une notification.
            "notify_leds",
            # Le lecteur signale poses ET retraits, et accepte "rfid_pairing".
            "rfid_presence",
        ]})
        await self.send(self.snapshot())
        errors = 0
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line)
                    if not isinstance(msg, dict):
                        continue
                    # {"audio_binary":{"size":N}} annonce N octets de WAV BRUT
                    # à la suite, sur la même socket (orb_bridge.rs). Le
                    # contrôleur n'a pas de haut-parleur: il faut malgré tout
                    # les consommer, sinon readline() découpe le PCM sur ses
                    # octets 0x0A et tente de parser du bruit à l'infini.
                    if "audio_binary" in msg:
                        await self._drain(reader, msg["audio_binary"])
                        continue
                    kind = msg.get("type")
                    if kind == "catalog":
                        self.apply_catalog(msg)
                    else:
                        # Les messages historiques de l'orbe n'ont pas de champ
                        # "type": {"mode":"listening"}, {"theme":...},
                        # {"heartbeat":...}. Les exiger revenait à ignorer tout
                        # ce que pushMode()/pushTheme() envoient, donc à figer
                        # la ligne d'état de l'écran. apply() ne retient que
                        # les clés qu'il connaît, le reste est sans effet.
                        self.apply(msg)
                except Exception as exc:
                    # Un flux désynchronisé produit une erreur par fragment.
                    # On résume au lieu d'inonder la console série, qui est
                    # notre seul outil de diagnostic.
                    errors += 1
                    if errors == 1 or errors % 50 == 0:
                        print("JSON: %s (%d erreurs)" % (exc, errors))
        finally:
            self.clients.discard(writer)
            self.state.connected = bool(self.clients)
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _drain(self, reader, header):
        """Consomme et jette N octets bruts annoncés par un en-tête binaire."""
        try:
            remaining = int(header.get("size", 0))
        except (AttributeError, TypeError, ValueError):
            return
        print("audio binaire ignore:", remaining, "octets")
        # Par tranches: le Pico W n'a pas de quoi tamponner un WAV entier.
        while remaining > 0:
            chunk = await reader.read(min(512, remaining))
            if not chunk:
                break
            remaining -= len(chunk)

    def apply_catalog(self, msg):
        """Remplace la liste de modèles d'un backend par celle de Lumen.

        Un backend absent du message garde sa liste précédente: si Ollama est
        hors ligne, l'application n'envoie rien pour lui et la molette continue
        de fonctionner avec le dernier catalogue connu.
        """
        models = msg.get("models")
        if isinstance(models, dict):
            for backend, names in models.items():
                if not isinstance(names, list):
                    continue
                # Déduplication: un doublon fausse index(), qui renvoie
                # toujours la première occurrence, et la molette se met à
                # sauter des entrées.
                seen = []
                for n in names:
                    if not n:
                        continue
                    name = str(n)[:48]
                    if name not in seen:
                        seen.append(name)
                    if len(seen) >= self.max_models:
                        break
                if seen:
                    if len(seen) >= self.max_models:
                        print("catalogue %s tronque a %d entrees"
                              % (backend, self.max_models))
                    self.state.models[str(backend)] = tuple(seen)
        # Voix de synthèse installées, dans le même message.
        voices = msg.get("voices")
        if isinstance(voices, list):
            clean = tuple(str(v)[:48] for v in voices if v)[:24]
            if clean:
                self.state.voices = clean
                if self.state.voice not in clean:
                    self.state.voice = clean[0]
        print("catalogue: %s, voix=%d" % (
            ", ".join("%s=%d" % (k, len(v)) for k, v in self.state.models.items()),
            len(self.state.voices),
        ))

    def apply(self, msg):
        """Applique un état poussé par Lumen. L'application fait autorité.

        Le modèle est accepté même s'il est absent du catalogue local de
        config.py: l'écran doit montrer ce que l'application utilise vraiment,
        pas ce que le firmware croit connaître.
        """
        s = self.state
        # "status" porte l'état BRUT de l'application (thinking, loading…),
        # alors que "mode" est réduit au vocabulaire à trois états de l'orbe
        # ESP32, qui confond notamment thinking et listening. On préfère donc
        # "status" dès qu'il est présent.
        if msg.get("status"):
            s.mode = str(msg["status"])
            msg = dict(msg)
            msg.pop("mode", None)
        for key in ("backend", "model", "mode", "chat_mode", "voice"):
            if key in msg and msg[key]:
                setattr(s, key, str(msg[key]))
        # Notification poussée par Lumen: {"notification": {"text": …,
        # "source": …, "color": "#ff9f0a"}}. La couleur vient de Réglages →
        # Notifications; absente, le firmware garde celle de config.py.
        notification = msg.get("notification")
        if isinstance(notification, dict):
            s.notify_color = str(notification.get("color") or "")
            s.notify_text = str(notification.get("text") or "")[:120]
            s.notify_seq += 1
        # Mode association: Lumen l'arme le temps qu'un écran attende un badge.
        # C'est la seule exception à la règle « un badge posé ne réémet rien ».
        if "rfid_pairing" in msg:
            s.rfid_pairing = bool(msg["rfid_pairing"])
        for key in ("desktop", "paused"):
            if key in msg:
                setattr(s, key, bool(msg[key]))
        for key, mini in (("ctx_used", 0), ("ctx_total", 0)):
            if key in msg:
                try:
                    setattr(s, key, max(mini, int(msg[key])))
                except (TypeError, ValueError):
                    pass
        if "tps" in msg:
            try:
                s.tps = max(0.0, float(msg["tps"]))
            except (TypeError, ValueError):
                pass
        if "volume" in msg:
            try:
                s.volume = max(0, min(100, int(msg["volume"])))
            except (TypeError, ValueError):
                pass

    async def serve(self):
        await asyncio.start_server(self._client, "0.0.0.0", self.port)
        while True:
            await self.send(self.snapshot())
            await asyncio.sleep_ms(2000)
