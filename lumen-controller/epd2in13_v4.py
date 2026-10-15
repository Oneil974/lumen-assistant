# Pilote MicroPython du Waveshare 2.13inch e-Paper HAT V4 (noir/blanc).
# Adapté du pilote Waveshare epd2in13_V4.py, licence MIT, 2023-06-25.
#
# Copyright Waveshare team. Permission is hereby granted, free of charge, to
# any person obtaining a copy of this software and associated documentation
# files, to deal in the Software without restriction, including without
# limitation the rights to use, copy, modify, merge, publish, distribute,
# sublicense, and/or sell copies. The above copyright and permission notice
# shall be included in all copies or substantial portions of the Software.
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO MERCHANTABILITY, FITNESS FOR A
# PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY.
#
# En paysage, le pilote Pico officiel utilise un framebuffer 250x128 en
# MONO_VLSB. Les 16 bandes horizontales sont transmises en ordre inverse.

import time
from machine import Pin, SPI


class EPD:
    WIDTH = 122
    HEIGHT = 250
    ROW_BYTES = 16
    BUFFER_SIZE = ROW_BYTES * HEIGHT

    # Tables officielles Waveshare du pilote 2.13 V3. Waveshare annonce la
    # dalle V4 compatible avec cette séquence.
    LUT_PARTIAL = bytes((
        0x00,0x40,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x80,0x80,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x40,0x40,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x80,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x14,0x00,0x00,0x00,0x00,0x00,0x00,
        0x01,0x00,0x00,0x00,0x00,0x00,0x00,
        0x01,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x22,0x22,0x22,0x22,0x22,0x22,0x00,0x00,0x00,
        0x22,0x17,0x41,0x00,0x32,0x36,
    ))
    LUT_FULL = bytes((
        0x80,0x4A,0x40,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x40,0x4A,0x80,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x80,0x4A,0x40,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x40,0x4A,0x80,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x0F,0x00,0x00,0x00,0x00,0x00,0x00,
        0x0F,0x00,0x00,0x0F,0x00,0x00,0x02,
        0x0F,0x00,0x00,0x00,0x00,0x00,0x00,
        0x01,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x22,0x22,0x22,0x22,0x22,0x22,0x00,0x00,0x00,
        0x22,0x17,0x41,0x00,0x32,0x36,
    ))

    # Miroir de chaque octet, pour la rotation à 180°. Table construite une
    # fois au chargement: 2000 inversions par rafraîchissement seraient bien
    # trop lentes à calculer en MicroPython.
    BITREV = bytearray(256)
    for _i in range(256):
        _v, _r = _i, 0
        for _ in range(8):
            _r = (_r << 1) | (_v & 1)
            _v >>= 1
        BITREV[_i] = _r
    del _i, _v, _r

    def __init__(self, cfg):
        self.cfg = cfg
        # 180° = image tête-bêche, pour un connecteur placé de l'autre côté.
        self.rotation = 180 if getattr(cfg, "EPD_ROTATION", 0) == 180 else 0
        self.timeout_ms = getattr(cfg, "EPD_BUSY_TIMEOUT_MS", 15000)
        self.busy_active = getattr(cfg, "EPD_BUSY_ACTIVE", 1)
        self.variant = getattr(cfg, "EPD_PANEL_DRIVER", "v3").lower()
        # Renseigné par _activate(): False signifie que la dalle n'a jamais
        # démarré de rafraîchissement, donc que le SPI ne l'atteint pas.
        self.busy_seen = None
        # Réordonnancement paysage: tampon permanent, jamais réalloué.
        self._ordered = bytearray(self.BUFFER_SIZE)

        # ORDRE CRITIQUE: le bus SPI est construit AVANT les GPIO de contrôle.
        #
        # Sur RP2040, le MISO par défaut de SPI1 est GP8, c'est-à-dire la
        # broche DC de ce câblage (et GP4 pour SPI0). MicroPython applique ce
        # défaut même quand seuls sck et mosi sont fournis: SPI() exécute alors
        # gpio_set_function(8, GPIO_FUNC_SPI) et confisque la broche. Un objet
        # Pin(8, Pin.OUT) créé AVANT devient inopérant, dc.on()/dc.off()
        # n'agissent plus sur le pad, commandes et données deviennent
        # indiscernables pour la dalle et la RAM image n'est jamais écrite:
        # l'écran rafraîchit alors son contenu non initialisé, donc de la
        # neige. Le pilote officiel Waveshare construit dc_pin après SPI(1)
        # pour cette raison exacte. Ne pas remonter ces lignes.
        kwargs = {
            "baudrate": getattr(cfg, "EPD_SPI_BAUD", 4_000_000),
            "polarity": 0,
            "phase": 0,
            "sck": Pin(cfg.EPD_PIN_SCK),
            "mosi": Pin(cfg.EPD_PIN_MOSI),
        }
        # MISO n'est pas utilisé par le HAT et certains ports RP2 le refusent.
        self.spi = SPI(cfg.EPD_SPI_ID, **kwargs)

        self.cs = Pin(cfg.EPD_PIN_CS, Pin.OUT, value=1)
        self.dc = Pin(cfg.EPD_PIN_DC, Pin.OUT, value=0)
        self.rst = Pin(cfg.EPD_PIN_RST, Pin.OUT, value=1)
        # Le pilote officiel arme la pull-up: un fil BUSY débranché lit alors 1
        # (occupé) et provoque un timeout explicite au lieu d'un écran muet.
        self.busy = Pin(cfg.EPD_PIN_BUSY, Pin.IN, Pin.PULL_UP)

    def _command(self, value):
        self.dc.off()
        self.cs.off()
        self.spi.write(bytes((value,)))
        self.cs.on()

    def _data(self, value):
        self.dc.on()
        self.cs.off()
        self.spi.write(bytes((value,)))
        self.cs.on()

    def _data_buffer(self, data):
        self.dc.on()
        self.cs.off()
        self.spi.write(data)
        self.cs.on()

    def _wait_idle(self, stage="operation"):
        started = time.ticks_ms()
        while self.busy.value() == self.busy_active:
            if time.ticks_diff(time.ticks_ms(), started) > self.timeout_ms:
                raise OSError(
                    "e-paper BUSY timeout stage=%s level=%d active=%d"
                    % (stage, self.busy.value(), self.busy_active)
                )
            time.sleep_ms(10)

    def reset(self):
        self.rst.on()
        time.sleep_ms(20)
        self.rst.off()
        time.sleep_us(getattr(self.cfg, "EPD_RESET_LOW_US", 2000))
        self.rst.on()
        time.sleep_ms(20)

    def _recover_power(self):
        """Réarme le circuit d'alimentation Rev 2.1 après un refresh bloqué."""
        duration = getattr(self.cfg, "EPD_POWER_RECOVERY_MS", 20)
        print("e-paper: BUSY active before init, power recovery")
        self.cs.on()
        self.dc.off()
        self.rst.off()
        time.sleep_ms(duration)
        self.rst.on()
        time.sleep_ms(150)

    def _set_window(self):
        self._command(0x44)
        self._data(0x00)
        self._data((self.WIDTH - 1) >> 3)
        self._command(0x45)
        self._data(0x00)
        self._data(0x00)
        self._data((self.HEIGHT - 1) & 0xFF)
        self._data((self.HEIGHT - 1) >> 8)

    def _set_cursor(self):
        self._command(0x4E)
        self._data(0x00)
        self._command(0x4F)
        self._data(0x00)
        self._data(0x00)

    def _set_lut(self, lut):
        self._command(0x32)
        self._data_buffer(lut[:153])
        self._wait_idle("lut")
        self._command(0x3F)
        self._data(lut[153])
        self._command(0x03)
        self._data(lut[154])
        self._command(0x04)
        self._data(lut[155])
        self._data(lut[156])
        self._data(lut[157])
        self._command(0x2C)
        self._data(lut[158])

    def init(self):
        print(
            "e-paper %s: SPI(%d) SCK=%d MOSI=%d CS=%d DC=%d RST=%d BUSY=%d level=%d"
            % (
                self.variant, self.cfg.EPD_SPI_ID, self.cfg.EPD_PIN_SCK,
                self.cfg.EPD_PIN_MOSI, self.cfg.EPD_PIN_CS,
                self.cfg.EPD_PIN_DC, self.cfg.EPD_PIN_RST,
                self.cfg.EPD_PIN_BUSY, self.busy.value(),
            )
        )
        if self.busy.value() == self.busy_active:
            self._recover_power()
        self.reset()
        # Le pilote officiel laisse 100 ms au circuit d'alimentation APRES le
        # reset, pas avant. Sans ce délai, le 0x12 qui suit peut être ignoré.
        time.sleep_ms(100)
        self._wait_idle("power-on")
        self._command(0x12)  # software reset
        self._wait_idle("software-reset")
        self._command(0x01)  # driver output: 250 gates
        self._data(0xF9)
        self._data(0x00)
        self._data(0x00)
        self._command(0x11)
        # Séquence paysage officielle Waveshare Pico 2.13 V4.
        self._data(0x07)
        self._set_window()
        self._set_cursor()
        self._command(0x3C)  # border waveform
        self._data(0x05)
        self._command(0x21)
        self._data(0x00)
        self._data(0x80)
        self._command(0x18)  # internal temperature sensor
        self._data(0x80)
        self._wait_idle("initialization")
        if self.variant == "v3":
            self._set_lut(self.LUT_FULL)

    def _activate(self, control):
        self._command(0x22)
        self._data(control)
        self._command(0x20)
        # Une dalle qui reçoit vraiment le SPI lève BUSY en quelques ms. Si le
        # niveau ne bouge jamais, inutile d'attendre le timeout: la commande
        # n'est pas arrivée (CS/DC/CLK/DIN, mauvais bus SPI, ou dalle non V4).
        self.busy_seen = False
        started = time.ticks_ms()
        while time.ticks_diff(time.ticks_ms(), started) < 100:
            if self.busy.value() == self.busy_active:
                self.busy_seen = True
                break
            time.sleep_ms(1)
        if not self.busy_seen:
            print("e-paper: BUSY n'est jamais monte apres 0x20 (ctrl=0x%02X)" % control)
        self._wait_idle("refresh")

    def clear(self, color=0xFF):
        """Rafraîchissement uni, sans framebuffer: isole le pilote de l'UI."""
        self._set_cursor()
        self._command(0x24)
        self._data_landscape(bytes((color,)) * self.BUFFER_SIZE)
        self._activate(0xF7 if self.variant == "v4" else 0xC7)

    def display_base(self, image):
        """Plein rafraîchissement et synchronisation des deux RAM."""
        image = self._landscape_stream(image)
        self._set_cursor()
        self._command(0x24)
        self._data_landscape(image)
        # Le compteur d'adresse a débordé de la fenêtre après les 4000 octets
        # précédents. On le replace explicitement avant la seconde RAM.
        self._set_cursor()
        self._command(0x26)
        self._data_landscape(image)
        self._activate(0xC7 if self.variant == "v3" else 0xF7)

    def display_full(self, image):
        """Plein rafraîchissement initial via RAM 0x24 uniquement.

        C'est la séquence utilisée par Clear()/display() dans l'exemple Pico
        officiel. Elle est volontairement distincte de Display_Base(), qui
        écrit également l'ancienne image dans la RAM 0x26.
        """
        image = self._landscape_stream(image)
        self._set_cursor()
        self._command(0x24)
        self._data_landscape(image)
        self._activate(0xF7 if self.variant == "v4" else 0xC7)

    def display_partial(self, image):
        """Rafraîchissement partiel plein écran, environ 0,3 s."""
        image = self._landscape_stream(image)
        if self.variant == "v3":
            self.rst.off()
            time.sleep_ms(1)
            self.rst.on()
            self._set_lut(self.LUT_PARTIAL)
            self._command(0x37)
            for value in (0, 0, 0, 0, 0, 0x40, 0, 0, 0, 0):
                self._data(value)
            self._command(0x3C)
            self._data(0x80)
            self._activate(0xC0)
            self._set_window()
            self._set_cursor()
            self._command(0x24)
            self._data_landscape(image)
            self._activate(0x0F)
            return
        # V4: le pilote officiel refait un reset complet (20 ms / 2 ms / 20 ms)
        # avant chaque rafraîchissement partiel. L'impulsion de 1 ms utilisée
        # auparavant laissait des HAT Rev 2.1 dans un état intermédiaire où
        # plus aucune mise à jour n'était visible.
        self.reset()
        self._command(0x3C)
        self._data(0x80)
        self._command(0x01)
        self._data(0xF9)
        self._data(0x00)
        self._data(0x00)
        self._command(0x11)
        self._data(0x07)
        self._set_window()
        self._set_cursor()
        self._command(0x24)
        self._data_landscape(image)
        self._activate(0xFF)

    def _data_landscape(self, data):
        """Envoi du framebuffer déjà réordonné, en un seul transfert SPI.

        Le pilote Waveshare Pico bascule CS à chaque octet uniquement parce
        qu'il transpose le buffer à la volée. Ici _landscape_stream() a déjà
        produit un tampon contigu: on peut donc utiliser send_data1(), le
        chemin groupé du pilote officiel. Une seule assertion de CS au lieu de
        4000 supprime autant d'occasions pour la dalle de perdre la
        synchronisation sur des fils Dupont longs, et rend le transfert ~50x
        plus rapide.
        """
        self._data_buffer(data)

    def _landscape_stream(self, image):
        """Réordonne le framebuffer comme le pilote Pico officiel Waveshare."""
        if len(image) != self.BUFFER_SIZE:
            raise ValueError(
                "e-paper buffer: %d octets recus, %d attendus"
                % (len(image), self.BUFFER_SIZE)
            )
        # Tampon alloué UNE fois. En allouer 4000 octets à chaque
        # rafraîchissement fragmentait le tas d'un Pico W déjà chargé
        # (asyncio, JSON, LEDs, RFID) jusqu'au MemoryError : la carte
        # redémarrait, l'écran clignotait à la ré-initialisation et l'état
        # repartait des valeurs par défaut de config.py.
        ordered = self._ordered
        destination = 0
        # (le retournement éventuel a lieu après le réordonnancement)
        # MONO_VLSB: 16 bandes de 8 lignes, chacune longue de 250 octets.
        for band in range(15, -1, -1):
            source = band * self.HEIGHT
            ordered[destination:destination + self.HEIGHT] = (
                image[source:source + self.HEIGHT]
            )
            destination += self.HEIGHT
        if self.rotation:
            self._flip(ordered)
        return ordered

    def _flip(self, buf):
        """Retourne l'image de 180° dans l'espace de la dalle.

        Le flux est envoyé octet par octet, X-octet majeur et Y mineur. Inverser
        l'ORDRE des octets échange donc (i, Y) en (15-i, 249-Y), et inverser les
        BITS de chaque octet échange les huit pixels qu'il contient. Les deux
        combinés donnent exactement pixel -> 127 - pixel et ligne -> 249 - ligne,
        c'est-à-dire une rotation de 180°.

        Le décalage de 6 lignes appliqué au dessin doit alors valoir 0: la
        transformation envoie les pixels 0..121 sur 6..127, et inversement.
        C'est ui.py qui s'en charge.
        """
        rev = self.BITREV
        last = self.BUFFER_SIZE - 1
        for k in range(self.BUFFER_SIZE // 2):
            a = buf[k]
            buf[k] = rev[buf[last - k]]
            buf[last - k] = rev[a]

    def sleep(self):
        self._command(0x10)
        self._data(0x01)
        time.sleep_ms(100)
