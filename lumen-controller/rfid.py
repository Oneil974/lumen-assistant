"""Lecteur RFID du contrôleur Lumen.

Le contrôleur est un simple CAPTEUR: il lit un UID et l'envoie à Lumen. Aucune
association badge -> action n'est stockée à bord. C'est l'application qui tient
la table et décide quoi faire, ce qui permet d'ajouter de nouvelles actions
sans jamais reflasher la carte.

Le lecteur suit la PRÉSENCE du badge, pas seulement son passage: un badge peut
rester posé sans que l'action se rejoue en boucle. On ne signale donc que les
transitions:

    absence -> badge X          -> événement ("badge", "04A2B3C4")
    badge X -> absence          -> événement ("removed", "")
    badge X -> badge Y (échange à chaud, sans retrait perceptible)
                                -> événement ("badge", "…") pour Y

Retirer puis reposer le même badge rejoue donc l'action, ce qui est le geste
naturel. Seul le mode ASSOCIATION (set_pairing) réémet périodiquement l'UID
présent: l'écran des Réglages doit pouvoir capturer un badge déjà posé.
"""
import time

from machine import Pin, SPI

try:
    from mfrc522 import MFRC522
except ImportError:
    MFRC522 = None


class Rfid:
    def __init__(self, cfg):
        self.reader = None
        # UID du badge actuellement POSÉ ("" = aucun). C'est l'état de
        # référence: tout le reste n'est que détection de ses changements.
        self.uid = ""
        self.last_seen = 0
        # En mode association seulement: cadence de réémission du badge posé.
        self.repeat_ms = int(getattr(cfg, "RFID_REPEAT_MS", 2500))
        self.poll_ms = int(getattr(cfg, "RFID_POLL_MS", 250))
        # Une carte posée n'est pas vue à TOUS les tours (champ, orientation,
        # collision). Déclarer l'absence au premier échec ferait clignoter la
        # présence et rejouerait l'action sans arrêt: il faut plusieurs
        # scrutations vides d'affilée.
        self.absent_polls = max(1, int(getattr(cfg, "RFID_ABSENT_POLLS", 3)))
        self.misses = 0
        self.pairing = False
        self.last_poll = 0
        self._error_logged = False

        pin_cs = getattr(cfg, "RFID_PIN_CS", None)
        if pin_cs is None or MFRC522 is None:
            if pin_cs is not None and MFRC522 is None:
                print("RFID desactive: mfrc522.py absent de la carte")
            return
        try:
            # ORDRE CRITIQUE, comme pour l'e-paper: le bus SPI est construit
            # AVANT les GPIO de contrôle. SPI() applique les broches par défaut
            # du bus (dont MISO) et confisque le pad; un Pin créé avant
            # deviendrait inopérant.
            spi = SPI(
                getattr(cfg, "RFID_SPI_ID", 0),
                baudrate=getattr(cfg, "RFID_SPI_BAUD", 1_000_000),
                polarity=0, phase=0,
                sck=Pin(cfg.RFID_PIN_SCK),
                mosi=Pin(cfg.RFID_PIN_MOSI),
                miso=Pin(cfg.RFID_PIN_MISO),
            )
            cs = Pin(pin_cs, Pin.OUT, value=1)
            rst = Pin(cfg.RFID_PIN_RST, Pin.OUT, value=1)
            self.reader = MFRC522(spi, cs, rst)
            version = self.reader.version()
            if version in (0x00, 0xFF):
                # Le bus répond mais pas la puce: câblage, alimentation, ou
                # cavaliers 1/2/3 du module pas sur SPI.
                print("RFID: aucune reponse du MFRC522 (VersionReg=0x%02X)" % version)
                self.reader = None
            else:
                print("RFID: MFRC522 detecte (VersionReg=0x%02X) sur SPI(%d)"
                      % (version, getattr(cfg, "RFID_SPI_ID", 0)))
        except Exception as exc:
            self.reader = None
            print("RFID desactive:", exc)

    def set_pairing(self, on):
        """Active le mode association (réémission du badge posé).

        Lumen le demande pendant qu'un écran d'association attend un badge:
        sans cela, un badge déjà posé au moment d'ouvrir l'écran ne serait
        jamais capturé, puisqu'il ne provoque plus aucune transition.
        """
        on = bool(on)
        if on == self.pairing:
            return
        self.pairing = on
        # Réémission immédiate à l'entrée en association si un badge est posé.
        if on:
            self.last_seen = time.ticks_add(time.ticks_ms(), -self.repeat_ms)

    def _scan(self):
        """UID du badge présent dans le champ, ou "" si le lecteur ne voit rien."""
        try:
            # WUPA plutôt que REQA: une carte déjà lue reste dans le champ mais
            # ne répond plus à REQA, et le badge posé passerait pour retiré.
            status, _ = self.reader.request(self.reader.REQALL)
            if status != self.reader.OK:
                return ""
            status, raw = self.reader.anticoll()
            if status != self.reader.OK or not raw:
                return ""
        except Exception as exc:
            # Un lecteur débranché à chaud ne doit pas tuer la boucle.
            if not self._error_logged:
                print("RFID: lecture impossible:", exc)
                self._error_logged = True
            return ""
        self._error_logged = False
        # Les 4 premiers octets sont l'UID; le cinquième est son BCC.
        return "".join("%02X" % b for b in raw[:4])

    def poll(self):
        """Transition de présence, ou None s'il ne se passe rien.

        Renvoie ("badge", uid) quand un badge arrive sur le lecteur, et
        ("removed", "") quand il en est retiré.
        """
        if not self.reader:
            return None
        # Même corrigée, une scrutation sans carte attend l'expiration du timer
        # du MFRC522 (~15 ms). L'appeler à chaque tour de boucle grèverait la
        # réactivité des boutons pour rien: un quart de seconde est imperceptible
        # au moment de poser un badge.
        now = time.ticks_ms()
        if time.ticks_diff(now, self.last_poll) < self.poll_ms:
            return None
        self.last_poll = now

        uid = self._scan()
        if not uid:
            # Lecture vide: absence seulement après plusieurs échecs d'affilée,
            # sinon un simple raté de lecture ferait croire à un retrait.
            if not self.uid:
                return None
            self.misses += 1
            if self.misses < self.absent_polls:
                return None
            self.uid = ""
            self.misses = 0
            return ("removed", "")

        self.misses = 0
        if uid != self.uid:
            # Nouveau badge: soit le lecteur était vide, soit on a échangé les
            # badges assez vite pour qu'aucune absence ne soit constatée.
            self.uid = uid
            self.last_seen = now
            return ("badge", uid)
        # Badge inchangé: rien à signaler, sauf en association.
        if self.pairing and time.ticks_diff(now, self.last_seen) >= self.repeat_ms:
            self.last_seen = now
            return ("badge", uid)
        return None

    def read(self):
        """UID d'un badge fraîchement posé, sinon None (compatibilité)."""
        event = self.poll()
        return event[1] if event and event[0] == "badge" else None
