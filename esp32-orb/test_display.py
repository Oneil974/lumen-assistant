# -*- coding: utf-8 -*-
# Test écran minimal, via l'init VERBATIM du firmware voiture (tft_config).
#   mpremote connect <port> run test_display.py
# Séquence attendue : rouge -> vert -> bleu, puis deux cercles.

import time
import gc9a01 as lcd
import tft_config
from backlight import Backlight

tft = tft_config.config()      # init exactement comme le firmware qui marche
bl = Backlight()               # PWM pin 2 à 100 % (le driver n'allume pas la BL)

for name, c in (("ROUGE", lcd.RED), ("VERT", lcd.GREEN), ("BLEU", lcd.BLUE)):
    print("fill", name)
    tft.fill(c)
    time.sleep(1)

tft.fill(lcd.BLACK)
tft.fill_circle(120, 120, 90, lcd.color565(80, 220, 200))
tft.fill_circle(120, 120, 40, lcd.WHITE)
print("OK — si tu vois les cercles, l'ecran fonctionne. Lance main.py.")
