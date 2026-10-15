# -*- coding: utf-8 -*-
# Rétroéclairage piloté en PWM (copie de Backup_ESPROUND/display/backlight.py,
# éprouvée sur cette carte). Le driver gc9a01 NE l'allume pas tout seul.

from machine import PWM, Pin


class Backlight:
    def __init__(self, pin=2, freq=5000):
        self.pwm = PWM(Pin(pin))
        self.pwm.freq(freq)
        self._brightness = 65535
        self.set(100)              # allumé à 100 % par défaut

    def set(self, percent):
        percent = max(0, min(100, percent))
        duty = int((percent / 100) * 65535)
        self.pwm.duty_u16(duty)
        self._brightness = duty

    def off(self):
        self.pwm.duty_u16(0)

    def on(self):
        self.pwm.duty_u16(self._brightness or 65535)

    def deinit(self):
        self.pwm.deinit()
