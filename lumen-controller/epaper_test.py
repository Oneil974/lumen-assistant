"""Test matériel autonome et progressif du Waveshare 2.13 V4.

Depuis l'ordinateur: mpremote connect auto run epaper_test.py

Le test se déroule en quatre étapes. Notez celle qui échoue: elle désigne
directement la cause.

  1. init      -> le dialogue SPI et la ligne BUSY répondent
  2. tout noir -> la dalle rafraîchit réellement (aucun framebuffer impliqué)
  3. tout blanc-> deuxième rafraîchissement, l'effacement fonctionne
  4. image     -> la géométrie paysage 250x128 est correcte
"""
import time
import config as cfg

try:
    import config_local as local
    for name in dir(local):
        if name.isupper():
            setattr(cfg, name, getattr(local, name))
except ImportError:
    pass

if getattr(cfg, "IS_PICO", False) and cfg.EPD_SPI_ID not in (0, 1):
    cfg.EPD_SPI_ID = 1
    cfg.EPD_PIN_SCK, cfg.EPD_PIN_MOSI = 10, 11
    cfg.EPD_PIN_CS, cfg.EPD_PIN_DC = 9, 8
    cfg.EPD_PIN_RST, cfg.EPD_PIN_BUSY = 12, 13

import framebuf
from epd2in13_v4 import EPD

if getattr(cfg, "IS_PICO", False):
    # MISO par défaut de chaque bus RP2040. SPI() confisque cette broche même
    # si on ne lui passe que sck et mosi: une broche de contrôle placée là doit
    # impérativement être (re)configurée APRES la création du SPI.
    default_miso = {0: 4, 1: 8}.get(cfg.EPD_SPI_ID)
    for label, pin in (("DC", cfg.EPD_PIN_DC), ("RST", cfg.EPD_PIN_RST),
                       ("CS", cfg.EPD_PIN_CS), ("BUSY", cfg.EPD_PIN_BUSY)):
        if pin == default_miso:
            print("note: %s=GP%d est le MISO par defaut de SPI(%d)"
                  % (label, pin, cfg.EPD_SPI_ID))

epd = EPD(cfg)

print("[1/4] init")
epd.init()
print("      init OK, BUSY au repos =", epd.busy.value())

print("[2/4] ecran entierement NOIR (~3 s de transfert)")
epd.clear(0x00)
print("      BUSY s'est leve pendant le refresh:", epd.busy_seen)
if not epd.busy_seen:
    print("      >> La dalle n'a PAS demarre de rafraichissement.")
    print("      >> Verifiez CS, DC, CLK/DIN et le bus SPI, pas le dessin.")
time.sleep(2)

print("[3/4] ecran entierement BLANC")
epd.clear(0xFF)
time.sleep(2)

print("[4/4] image de test")
buf = bytearray(250 * 16)
fb = framebuf.FrameBuffer(buf, 250, 128, framebuf.MONO_VLSB)
fb.fill(1)
fb.rect(1, 1, 248, 120, 0)
fb.text("WAVESHARE 2.13 V4", 42, 30, 0)
fb.text("LUMEN CONTROLLER", 50, 52, 0)
fb.text("SPI + BUSY: OK", 66, 74, 0)
fb.hline(25, 94, 200, 0)
epd.display_base(buf)
print("e-paper test: OK")
