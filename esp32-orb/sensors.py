# -*- coding: utf-8 -*-
# Couche tactile CST816. L'IMU QMI8658 n'est volontairement plus initialisée
# ni interrogée : elle n'apportait rien à l'interface et coûtait du temps CPU.

from machine import Pin, I2C

try:
    from cst816 import CST816
except Exception:
    CST816 = None

# Codes de gestes CST816
G_NONE = 0
G_UP = 1
G_DOWN = 2
G_LEFT = 3
G_RIGHT = 4
G_CLICK = 5
G_DOUBLE = 11
G_LONG = 12


class Sensors:
    def __init__(self):
        self.touch = None

        # Bus I2C du tactile (GPIO 6/7).
        self._i2c = I2C(0, scl=Pin(7), sda=Pin(6), freq=400000)

        if CST816 is not None:
            try:
                t = CST816(i2c=self._i2c)
                t.set_mode(3)          # mode combiné : gestes + coordonnées X/Y
                self.touch = t
                print("Tactile CST816 OK")
            except Exception as e:
                print("Tactile absent:", e)

        self._last_g = 0

    def poll_gesture(self):
        # Renvoie le geste une seule fois par contact. Le CST816 peut laisser
        # le même code actif plusieurs cycles ; l'ancien anti-rebond le
        # réémettait après 350 ms et faisait défiler les menus tout seul.
        if self.touch is None:
            return 0
        try:
            g = self.touch.get_gesture()
        except Exception:
            return 0
        if not g:
            self._last_g = 0
            return 0
        if g != self._last_g:
            self._last_g = g
            return g
        return 0

    def poll_event(self):
        """Renvoie (geste, x, y), une seule fois par contact.

        Les coordonnées sont utiles pour toucher directement les boutons ; les
        swipes restent exposés via ``geste``.
        """
        g = self.poll_gesture()
        if not g or self.touch is None:
            return (0, None, None)
        try:
            p = self.touch.get_point()
            return (g, int(p.x_point), int(p.y_point))
        except Exception:
            return (g, None, None)
