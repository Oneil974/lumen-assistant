"""ESP32-S3-LCD-1.28 — init écran VERBATIM depuis Backup_ESPROUND (firmware
voiture qui fonctionne). Ne rien changer ici : c'est la référence connue-bonne.
https://www.waveshare.com/wiki/ESP32-S3-LCD-1.28
"""

from machine import Pin, SPI
import gc9a01

TFA = 0
BFA = 0
WIDE = 0
TALL = 1


def config(rotation=0, buffer_size=0, options=0):
    spi = SPI(2, baudrate=80000000, sck=Pin(10), polarity=0, mosi=Pin(11))

    tft = gc9a01.GC9A01(
        spi,
        240,
        240,
        reset=Pin(14, Pin.OUT),
        cs=Pin(9, Pin.OUT),
        dc=Pin(8, Pin.OUT),
        backlight=Pin(2, Pin.OUT),
        rotation=rotation,
        options=options,
        buffer_size=buffer_size)
    # ⚠️ CE build du driver n'initialise PAS le panneau dans le constructeur :
    # sans init(), fill()/fill_circle() n'affichent rien (aucune erreur, écran
    # noir). Indispensable ici (v1.22.2-dirty Generic ESP32S3).
    tft.init()
    return tft
