"""Entrées sans dépendance à un framework: encodeurs et boutons anti-rebond."""
import time
from machine import Pin


class Encoder:
    """Encodeur en quadrature décodé par INTERRUPTION.

    La scrutation ne convient pas ici. Un cran produit quatre transitions en
    quelques dizaines de millisecondes ; la boucle principale, qui tourne
    toutes les POLL_MS (80 ms par défaut) et bloque plusieurs centaines de ms
    à chaque rafraîchissement de l'e-paper, en manquait la quasi-totalité.
    Un saut de deux états vaut 0 dans la table de quadrature : l'accumulateur
    n'atteignait donc jamais le seuil d'un cran et rien ne se passait.

    Les interruptions capturent chaque front, indépendamment de la cadence de
    la boucle. `read()` se contente ensuite de vider le compteur.
    """

    # Table de quadrature indexée par (état précédent << 2) | état courant.
    TABLE = (0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0)

    def __init__(self, pin_a, pin_b, per_detent=4, reversed=False):
        self.a = Pin(pin_a, Pin.IN, Pin.PULL_UP)
        self.b = Pin(pin_b, Pin.IN, Pin.PULL_UP)
        self.per_detent = max(1, int(per_detent))
        self.sign = -1 if reversed else 1
        self.last = (self.a.value() << 1) | self.b.value()
        self.acc = 0
        self.detents = 0
        self.transitions = 0          # diagnostic: fronts vus depuis le boot
        self.irq_ok = False
        try:
            trigger = Pin.IRQ_RISING | Pin.IRQ_FALLING
            self.a.irq(handler=self._isr, trigger=trigger)
            self.b.irq(handler=self._isr, trigger=trigger)
            self.irq_ok = True
        except (AttributeError, OSError, ValueError) as exc:
            # Port sans irq() sur cette broche: on retombe sur la scrutation,
            # dégradée mais pas muette.
            print("encodeur: interruptions indisponibles (%s), scrutation" % exc)

    def _isr(self, pin):
        self._step((self.a.value() << 1) | self.b.value())

    def _step(self, cur):
        if cur == self.last:
            return
        self.acc += self.TABLE[(self.last << 2) | cur]
        self.last = cur
        self.transitions += 1
        if self.acc >= self.per_detent:
            self.acc -= self.per_detent
            self.detents += self.sign
        elif self.acc <= -self.per_detent:
            self.acc += self.per_detent
            self.detents -= self.sign

    def read(self):
        """Crans accumulés depuis le dernier appel (peut valoir ±2, ±3…)."""
        if not self.irq_ok:
            self._step((self.a.value() << 1) | self.b.value())
        delta = self.detents
        if delta:
            # Soustraire plutôt qu'affecter 0 : une interruption survenant
            # entre les deux lignes n'est alors pas perdue.
            self.detents -= delta
        return delta


class Button:
    """Bouton anti-rebond, avec appui long optionnel.

    Sans `long_ms`, le comportement est celui d'origine: "down" à l'appui et
    "up" au relâchement.

    Avec `long_ms`, on ne peut plus agir dès l'appui puisqu'on ignore encore
    s'il sera court ou long. Les événements deviennent donc:
      - "long"  dès que le seuil est franchi, sans attendre le relâchement,
                ce qui donne un retour immédiat à l'utilisateur;
      - "click" au relâchement, uniquement si "long" n'a pas déjà été émis.
    """

    def __init__(self, pin, active_low=True, debounce_ms=35, long_ms=None):
        self.pin = Pin(pin, Pin.IN, Pin.PULL_UP)
        self.active_low = active_low
        self.debounce_ms = debounce_ms
        self.long_ms = long_ms
        self.raw = self.stable = self._pressed()
        # Daté dans le passé: sinon le tout premier appui, s'il survient dans
        # les premières millisecondes, serait pris pour un rebond et jeté.
        self.changed_at = time.ticks_add(time.ticks_ms(), -(debounce_ms + 1))
        self.pressed_at = self.changed_at
        self.long_fired = False
        # Événements capturés par l'interruption, en attente de lecture.
        self.pending_down = 0
        self.pending_click = 0
        self.pending_long = 0
        self.irq_ok = False
        try:
            self.pin.irq(handler=self._isr,
                         trigger=Pin.IRQ_RISING | Pin.IRQ_FALLING)
            self.irq_ok = True
        except (AttributeError, OSError, ValueError):
            pass                    # port sans irq(): on retombe sur la scrutation

    def _pressed(self):
        value = self.pin.value()
        return value == 0 if self.active_low else value == 1

    def _isr(self, pin):
        """Capture les fronts, même si la boucle principale est bloquée.

        L'e-paper monopolise plusieurs centaines de millisecondes à chaque
        rafraîchissement. Un appui court tombant dans cette fenêtre était
        purement et simplement perdu: la scrutation ne voyait ni le front
        descendant ni le front montant.
        """
        now = time.ticks_ms()
        if time.ticks_diff(now, self.changed_at) < self.debounce_ms:
            return                              # rebond mécanique
        pressed = self._pressed()
        if pressed == self.stable:
            return
        self.stable = pressed
        self.changed_at = now
        if pressed:
            self.pressed_at = now
            self.long_fired = False
            if self.long_ms is None:
                self.pending_down += 1
            return
        # Relâchement: c'est ici qu'on tranche entre court et long lorsque tout
        # l'appui s'est déroulé pendant un blocage de la boucle.
        if self.long_ms is not None and not self.long_fired:
            if time.ticks_diff(now, self.pressed_at) >= self.long_ms:
                self.pending_long += 1
            else:
                self.pending_click += 1

    def _poll(self):
        """Repli sans interruption: même logique, cadencée par la boucle."""
        now = time.ticks_ms()
        raw = self._pressed()
        if raw != self.raw:
            self.raw, self.changed_at = raw, now
        if raw != self.stable and time.ticks_diff(now, self.changed_at) >= self.debounce_ms:
            self.stable = raw
            if raw:
                self.pressed_at = now
                self.long_fired = False
                if self.long_ms is None:
                    self.pending_down += 1
            elif self.long_ms is not None and not self.long_fired:
                if time.ticks_diff(now, self.pressed_at) >= self.long_ms:
                    self.pending_long += 1
                else:
                    self.pending_click += 1

    def event(self):
        # La scrutation tourne TOUJOURS, même avec les interruptions.
        #
        # L'anti-rebond de l'ISR rejette les fronts trop rapprochés — y compris
        # lorsqu'un de ces fronts était le dernier. L'état interne restait alors
        # bloqué sur « enfoncé » et le bouton ne répondait plus qu'une fois sur
        # deux. La scrutation resynchronise l'état sur le niveau réel de la
        # broche ; les deux chemins partagent la même machine à états et testent
        # `raw != self.stable`, donc aucun événement n'est compté deux fois.
        self._poll()
        # Appui maintenu: on bascule en "long" sans attendre le relâchement,
        # pour que l'utilisateur ait un retour immédiat.
        if (self.long_ms is not None and self.stable and not self.long_fired
                and time.ticks_diff(time.ticks_ms(), self.pressed_at) >= self.long_ms):
            self.long_fired = True
            return "long"
        if self.pending_long:
            self.pending_long -= 1
            return "long"
        if self.pending_click:
            self.pending_click -= 1
            return "click"
        if self.pending_down:
            self.pending_down -= 1
            return "down"
        return None


class Potentiometer:
    """Potentiomètre analogique 0..100 %, filtré et avec zone morte."""

    def __init__(self, pin, deadband=2, reversed=False, attenuation=True):
        from machine import ADC
        try:
            self.adc = ADC(Pin(pin))
        except TypeError:
            self.adc = ADC(pin)
        if attenuation:
            try:
                self.adc.atten(ADC.ATTN_11DB)
            except (AttributeError, OSError):
                pass
        try:
            self.adc.width(ADC.WIDTH_12BIT)
        except (AttributeError, OSError):
            pass
        self.deadband = max(1, int(deadband))
        self.reversed = reversed
        self.last = None
        self.filtered = None

    def _raw_u16(self):
        try:
            return self.adc.read_u16()
        except AttributeError:
            # ESP32: read() renvoie généralement 0..4095.
            return self.adc.read() * 65535 // 4095

    def read(self):
        raw = self._raw_u16()
        # Filtre exponentiel entier pour supprimer le bruit du curseur.
        self.filtered = raw if self.filtered is None else (
            self.filtered * 3 + raw
        ) // 4
        value = max(0, min(100, (self.filtered * 100 + 32767) // 65535))
        if self.reversed:
            value = 100 - value
        if self.last is None or abs(value - self.last) >= self.deadband:
            self.last = value
            return value
        return None
