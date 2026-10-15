# -*- coding: utf-8 -*-
# Bandeau WS2812B synchronisé avec l'orbe : mêmes couleurs (dégradé aurora du
# thème) + même sensation de mouvement (position qui oscille) + même
# respiration (douce en veille, pulsée sur le niveau audio quand Lumen parle).
#
# Câblage : DATA sur cfg.LED_PIN (via ~330 Ω), VCC 3.3V, GND commun. Pour 3-4
# LEDs à faible luminosité, le 3.3V suffit ; ajoute un condensateur d'alim.

import math
import time
import neopixel
from machine import Pin


def _lerp(a, b, u):
    return (a[0] + (b[0] - a[0]) * u,
            a[1] + (b[1] - a[1]) * u,
            a[2] + (b[2] - a[2]) * u)


def _grad(stops, t):
    # échantillonne une couleur du dégradé (stops répartis sur [0,1])
    if t < 0.0:
        t = 0.0
    elif t > 1.0:
        t = 1.0
    n = len(stops)
    if n == 1:
        return stops[0]
    p = t * (n - 1)
    i = int(p)
    if i >= n - 1:
        return stops[-1]
    return _lerp(stops[i], stops[i + 1], p - i)


class Leds:
    def __init__(self, cfg, orb):
        self.cfg = cfg
        self.orb = orb
        self.n = max(1, cfg.LED_COUNT)
        self.np = neopixel.NeoPixel(Pin(cfg.LED_PIN), self.n)
        self.bmax = cfg.LED_BRIGHTNESS / 100.0
        self.speed = getattr(cfg, "LED_SPEED", 0.6)
        self.span = getattr(cfg, "LED_SPAN", 0.6)
        self._off = False

    def _fill0(self):
        for i in range(self.n):
            self.np[i] = (0, 0, 0)
        self.np.write()

    def update(self):
        # éteint en veille (écran off) — un seul write pour économiser
        if getattr(self.orb, "standby", False):
            if not self._off:
                self._fill0()
                self._off = True
            return
        self._off = False

        th = self.orb._th
        if not th:
            return
        stops = th.get("aurora") or [th.get("mid", (80, 120, 200))]

        t = time.ticks_ms() / 1000.0
        # position qui va-et-vient (ping-pong) -> déplacement doux des couleurs
        phase = 0.5 - 0.5 * math.cos(t * self.speed)

        # respiration : identique à l'orbe selon l'état
        mode = self.orb.mode
        if mode == "speaking":
            lvl = self.orb.level
            lvl = 0.0 if lvl < 0.0 else (1.0 if lvl > 1.0 else lvl)
            b = 0.35 + 0.65 * lvl
        elif mode == "listening":
            b = 0.6 + 0.4 * (0.5 + 0.5 * math.sin(t * 3))
        else:
            b = 0.55 + 0.45 * (0.5 + 0.5 * math.sin(t * 1.5))
        b *= self.bmax

        span = self.span
        denom = max(1, self.n - 1)
        for i in range(self.n):
            frac = i / denom
            col = _grad(stops, frac * span + phase * (1.0 - span))
            self.np[i] = (int(col[0] * b), int(col[1] * b), int(col[2] * b))
        self.np.write()
