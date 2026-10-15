"""Bandeau WS2812B: indication lumineuse de l'état de Lumen.

L'écran e-paper est lent (plusieurs centaines de ms par rafraîchissement) et
n'a pas de couleur. Les LEDs donnent donc l'information instantanée et visible
de loin: Lumen écoute, réfléchit, répond.

Deux notions distinctes, à ne pas confondre:

  - la COULEUR D'ÉTAT, imposée par Lumen (écoute, réflexion, réponse…). Elle
    n'est pas configurable: c'est une sémantique, pas une décoration.
  - la COULEUR DE BASE, choisie par l'utilisateur avec l'encodeur. Elle ne
    s'applique qu'au repos, quand aucun état ne la remplace.
  - la COULEUR DE NOTIFICATION, choisie dans Réglages → Notifications de
    Lumen et envoyée avec chaque notification. Elle prime quelques secondes
    sur tout le reste (pulse rapide et franc, visible de loin), puis l'état
    reprend la main.
"""
import time

try:
    import neopixel
except ImportError:                     # port MicroPython sans le module
    neopixel = None
from machine import Pin


# Couleurs choisissables à l'encodeur pour l'état de repos.
BASE_COLORS = (
    ("Blue", (30, 90, 200)),
    ("Violet", (140, 60, 220)),
    ("Teal", (0, 190, 170)),
    ("Amber", (255, 140, 20)),
    ("Rose", (255, 60, 140)),
    ("White", (180, 180, 180)),
    ("Off", (0, 0, 0)),
)


def parse_color(value, fallback=(255, 159, 10)):
    """« #ff9f0a » (ou (r,g,b)) -> (255, 159, 10). Tolérant: repli si invalide."""
    if isinstance(value, (tuple, list)) and len(value) == 3:
        try:
            return tuple(max(0, min(255, int(c))) for c in value)
        except (TypeError, ValueError):
            return fallback
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:                        # forme courte « #f80 »
        text = "".join(c * 2 for c in text)
    if len(text) != 6:
        return fallback
    try:
        return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))
    except ValueError:
        return fallback


class Leds:
    # Couleur et animation par état. "pulse" respire vite (activité en cours),
    # "breathe" respire lentement (attente), None reste fixe.
    STATES = {
        "idle": (None, "breathe"),          # None = couleur de base choisie
        "ready": (None, "breathe"),
        "listening": ((0, 120, 255), "pulse"),
        "thinking": ((255, 150, 0), "pulse"),
        "speaking": ((0, 220, 140), "pulse"),
        "loading": ((160, 60, 255), "pulse"),
        "error": ((255, 0, 0), None),
    }

    def __init__(self, cfg):
        self.notify_color = parse_color(getattr(cfg, "NOTIFY_COLOR", "#ff9f0a"))
        self.notify_ms = int(getattr(cfg, "NOTIFY_MS", 4000))
        self._notify_until = None            # None = aucune notification en cours
        # Replis alignés sur config.py : une carte dont le config_local.py est
        # incomplet doit se comporter comme la configuration de référence.
        self.count = int(getattr(cfg, "LED_COUNT", 3))
        self.brightness = max(0, min(100, int(getattr(cfg, "LED_BRIGHTNESS", 50))))
        self.color_index = int(getattr(cfg, "LED_COLOR_INDEX", 0)) % len(BASE_COLORS)
        self.state = "idle"
        self.strip = None
        self._last = None
        # Chaque write() bit-bang les LEDs interruptions DÉSACTIVÉES. Trop
        # fréquent, il ferait perdre des fronts à l'encodeur et aux boutons,
        # qui sont désormais sur interruption. 25 rafraîchissements par seconde
        # suffisent largement pour une respiration.
        self._next_write = 0
        self._min_interval = int(getattr(cfg, "LED_MIN_INTERVAL_MS", 40))
        pin = getattr(cfg, "LED_PIN", None)
        if pin is None or neopixel is None or self.count <= 0:
            if pin is not None and neopixel is None:
                print("LEDs desactivees: module neopixel absent")
            return
        try:
            self.strip = neopixel.NeoPixel(Pin(pin, Pin.OUT), self.count)
            self.clear()
            print("LEDs: %d WS2812B sur GPIO%d" % (self.count, pin))
        except Exception as exc:          # broche invalide, RAM insuffisante…
            self.strip = None
            print("LEDs desactivees:", exc)

    @property
    def color_name(self):
        return BASE_COLORS[self.color_index][0]

    def cycle_color(self, step=1):
        self.color_index = (self.color_index + step) % len(BASE_COLORS)
        self._last = None                 # force le rafraîchissement
        return self.color_name

    def set_state(self, name):
        name = str(name or "idle").lower()
        if name != self.state:
            self.state = name
            self._last = None

    def notify(self, color=None, duration_ms=None):
        """Déclenche une notification lumineuse: pulse franc pendant N ms.

        Appelée à la réception d'un message `notification` de Lumen. La couleur
        vient des réglages de l'application; à défaut, celle de config.py.
        """
        if color is not None:
            self.notify_color = parse_color(color, self.notify_color)
        span = int(duration_ms or self.notify_ms)
        self._notify_until = time.ticks_add(time.ticks_ms(), max(200, span))
        self._last = None                     # force le rafraîchissement
        return self.notify_color

    def notifying(self):
        return (self._notify_until is not None
                and time.ticks_diff(self._notify_until, time.ticks_ms()) > 0)

    def clear(self):
        if not self.strip:
            return
        for i in range(self.count):
            self.strip[i] = (0, 0, 0)
        self.strip.write()

    def _scale(self, color, factor):
        k = self.brightness * factor / 100.0
        return (int(color[0] * k), int(color[1] * k), int(color[2] * k))

    def tick(self):
        """À appeler régulièrement depuis la boucle principale."""
        if not self.strip:
            return
        now = time.ticks_ms()
        if time.ticks_diff(now, self._next_write) < 0:
            return
        self._next_write = time.ticks_add(now, self._min_interval)
        # Une notification prime sur l'état: c'est un événement ponctuel qu'il
        # faut voir de l'autre bout de la pièce. Elle bat plus vite et descend
        # presque à l'extinction, là où les états respirent entre 25 et 100 %.
        if self._notify_until is not None:
            if time.ticks_diff(self._notify_until, now) <= 0:
                self._notify_until = None     # échue: l'état reprend la main
                self._last = None
            else:
                phase = now % 500
                ramp = phase if phase < 250 else 500 - phase
                factor = 0.05 + 0.95 * ramp / 250
                scaled = self._scale(self.notify_color, factor)
                if scaled != self._last:
                    self._last = scaled
                    for i in range(self.count):
                        self.strip[i] = scaled
                    self.strip.write()
                return

        color, animation = self.STATES.get(self.state, self.STATES["idle"])
        if color is None:
            color = BASE_COLORS[self.color_index][1]

        if animation == "pulse":
            period = 900
        elif animation == "breathe":
            period = 3600
        else:
            period = 0

        if period:
            # Rampe triangulaire: pas de sinus, pas de flottant coûteux.
            phase = time.ticks_ms() % period
            half = period // 2
            ramp = phase if phase < half else period - phase
            factor = 0.25 + 0.75 * ramp / half
        else:
            factor = 1.0

        scaled = self._scale(color, factor)
        # Ne réécrit le bandeau que si la valeur a bougé: chaque write() bloque
        # les interruptions et perturberait le SPI de l'e-paper.
        if scaled == self._last:
            return
        self._last = scaled
        for i in range(self.count):
            self.strip[i] = scaled
        self.strip.write()
