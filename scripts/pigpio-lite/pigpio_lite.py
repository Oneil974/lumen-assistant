#!/usr/bin/env python3
"""pigpio-lite — remplaçant minimal de pigpiod pour Raspberry Pi 5.

Sur le Pi 5, le GPIO passe par le southbridge RP1 et pigpio/pigpiod ne fonctionne
plus. Ce démon réimplémente, au-dessus de la bibliothèque **lgpio** (supportée sur
Pi 5), exactement le sous-ensemble de commandes `pigs` qu'utilisent les blocs
Raspberry Pi de Lumen/Fluxo :

    m w r pud p pfs s            (GPIO / PWM / servo)
    i2co i2cwb i2crb i2cc        (I²C)
    spio spix spic               (SPI)

Il écoute sur un socket Unix ; le client `pigs` (fourni à côté) traduit
`pigs <args>` en requête vers ce démon et imprime la réponse au format attendu.

État conservé entre les appels (broches réclamées, fréquences PWM, handles I²C/SPI),
ce que pigpiod faisait et qu'un simple CLI éphémère ne peut pas faire.

Prérequis :  sudo apt install python3-lgpio   (ou : pip install lgpio)
Lancement   :  via systemd (voir pigpio-lite.service) — tourne en root.
Protocole   :  une ligne par requête « cmd args… » → réponse « OK [valeur] » ou « ERR msg ».
"""

import os
import socket
import socketserver
import threading
import sys

try:
    import lgpio
except ImportError:
    sys.stderr.write(
        "pigpio-lite : module « lgpio » introuvable. "
        "Installe-le : sudo apt install python3-lgpio\n"
    )
    sys.exit(1)

SOCK_PATH = os.environ.get("PIGPIO_LITE_SOCK", "/run/pigpio-lite.sock")

# Chips GPIO candidats : Pi 5 (Bookworm récent) = gpiochip0 ; certaines versions = 4.
GPIOCHIP_CANDIDATES = [0, 4]

# Drapeaux de tirage lgpio (avec repli si une constante manque selon la version).
PULL = {
    "u": getattr(lgpio, "SET_PULL_UP", 0x20),
    "d": getattr(lgpio, "SET_PULL_DOWN", 0x40),
    "o": getattr(lgpio, "SET_PULL_NONE", 0x80),
}


class Gpio:
    """Encapsule l'état matériel partagé (un handle de chip + suivi des broches)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.h = self._open_chip()
        self.mode = {}          # pin -> ("out"|"in")
        self.pwm_freq = {}      # pin -> fréquence Hz (défaut 800)
        self.i2c = set()        # handles I²C ouverts
        self.spi = set()        # handles SPI ouverts

    def _open_chip(self):
        last = None
        for c in GPIOCHIP_CANDIDATES:
            try:
                return lgpio.gpiochip_open(c)
            except Exception as e:  # noqa: BLE001
                last = e
        raise RuntimeError(f"Aucun gpiochip ouvrable {GPIOCHIP_CANDIDATES} : {last}")

    # --- gestion des broches (réclamation à la demande) ---
    def ensure_output(self, pin, level=0):
        if self.mode.get(pin) != "out":
            self._free(pin)
            lgpio.gpio_claim_output(self.h, pin, level)
            self.mode[pin] = "out"

    def ensure_input(self, pin, pull_flag=None):
        # Toujours re-réclamer si on change le tirage (lgpio ne le change pas sinon).
        self._free(pin)
        if pull_flag is not None:
            lgpio.gpio_claim_input(self.h, pull_flag, pin)
        else:
            lgpio.gpio_claim_input(self.h, pin)
        self.mode[pin] = "in"

    def _free(self, pin):
        if pin in self.mode:
            try:
                lgpio.gpio_free(self.h, pin)
            except Exception:  # noqa: BLE001
                pass
            self.mode.pop(pin, None)


GPIO = Gpio()


def handle(parts):
    """Exécute une commande « pigs » et renvoie la chaîne de réponse (sans préfixe)."""
    cmd = parts[0]
    a = parts[1:]

    # ---------------- GPIO ----------------
    if cmd == "m":  # mode : m <pin> <r|w>
        pin, mode = int(a[0]), a[1]
        if mode == "w":
            GPIO.ensure_output(pin)
        else:
            GPIO.ensure_input(pin)
        return ""
    if cmd == "w":  # write : w <pin> <0|1>
        pin, lvl = int(a[0]), int(a[1])
        GPIO.ensure_output(pin)
        lgpio.gpio_write(GPIO.h, pin, 1 if lvl else 0)
        return ""
    if cmd == "r":  # read : r <pin>
        pin = int(a[0])
        if GPIO.mode.get(pin) != "in":
            GPIO.ensure_input(pin)
        return str(lgpio.gpio_read(GPIO.h, pin))
    if cmd == "pud":  # pull : pud <pin> <u|d|o>
        pin = int(a[0])
        GPIO.ensure_input(pin, PULL.get(a[1], PULL["o"]))
        return ""

    # ---------------- PWM / servo ----------------
    if cmd == "pfs":  # set PWM frequency : pfs <pin> <freq>
        pin, freq = int(a[0]), int(a[1])
        GPIO.pwm_freq[pin] = freq
        return str(freq)
    if cmd == "p":  # PWM duty 0-255 : p <pin> <duty>
        pin, duty = int(a[0]), int(a[1])
        GPIO.ensure_output(pin)
        freq = GPIO.pwm_freq.get(pin, 800)
        # lgpio : rapport cyclique en pourcentage (0-100). pigs : 0-255.
        lgpio.tx_pwm(GPIO.h, pin, freq, max(0.0, min(100.0, duty / 255.0 * 100.0)))
        return ""
    if cmd == "s":  # servo pulse µs : s <pin> <pulse>
        pin, pulse = int(a[0]), int(a[1])
        GPIO.ensure_output(pin)
        lgpio.tx_servo(GPIO.h, pin, pulse)
        return ""

    # ---------------- I²C ----------------
    if cmd == "i2co":  # open : i2co <bus> <addr> <flags> -> handle
        bus, addr = int(a[0]), int(a[1])
        hh = lgpio.i2c_open(bus, addr)
        GPIO.i2c.add(hh)
        return str(hh)
    if cmd == "i2cwb":  # write byte : i2cwb <handle> <reg> <val>
        hh, reg, val = int(a[0]), int(a[1]), int(a[2])
        lgpio.i2c_write_byte_data(hh, reg, val)
        return ""
    if cmd == "i2crb":  # read byte : i2crb <handle> <reg> -> val
        hh, reg = int(a[0]), int(a[1])
        return str(lgpio.i2c_read_byte_data(hh, reg))
    if cmd == "i2cc":  # close : i2cc <handle>
        hh = int(a[0])
        lgpio.i2c_close(hh)
        GPIO.i2c.discard(hh)
        return ""

    # ---------------- SPI ----------------
    if cmd == "spio":  # open : spio <channel> <baud> <flags> -> handle
        chan, baud, flags = int(a[0]), int(a[1]), int(a[2]) if len(a) > 2 else 0
        hh = lgpio.spi_open(chan, baud, flags)
        GPIO.spi.add(hh)
        return str(hh)
    if cmd == "spix":  # transfer : spix <handle> <b0> <b1>… -> "count o0 o1…"
        hh = int(a[0])
        data = bytes(int(x) & 0xFF for x in a[1:])
        count, rx = lgpio.spi_xfer(hh, data)
        return " ".join([str(count)] + [str(b) for b in rx])
    if cmd == "spic":  # close : spic <handle>
        hh = int(a[0])
        lgpio.spi_close(hh)
        GPIO.spi.discard(hh)
        return ""

    raise ValueError(f"commande inconnue : {cmd}")


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        for raw in self.rfile:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            parts = line.split()
            try:
                with GPIO.lock:
                    out = handle(parts)
                resp = "OK" + (f" {out}" if out != "" else "")
            except Exception as e:  # noqa: BLE001
                resp = f"ERR {e}"
            self.wfile.write((resp + "\n").encode("utf-8"))
            self.wfile.flush()


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)
    srv = Server(SOCK_PATH, Handler)
    os.chmod(SOCK_PATH, 0o666)  # accessible à l'utilisateur de Lumen
    sys.stderr.write(f"pigpio-lite : à l'écoute sur {SOCK_PATH}\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.shutdown()
        if os.path.exists(SOCK_PATH):
            os.unlink(SOCK_PATH)


if __name__ == "__main__":
    main()
