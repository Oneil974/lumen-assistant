"""Pilote MicroPython minimal du MFRC522 (RFID 13,56 MHz, SPI).

Réduit à ce dont le contrôleur a besoin : détecter une carte et lire son UID.
Ni lecture ni écriture de secteurs, ni authentification MIFARE.

Le module RobotDyn expose SDA (= CS), SCK, MOSI, MISO, IRQ, GND, RST, 3.3V,
5V et PWR. Alimenter uniquement en 3,3 V ; IRQ et PWR restent libres.
"""
from machine import Pin, SPI


class MFRC522:
    OK = 0
    NOTAGERR = 1
    ERR = 2

    REQIDL = 0x26
    # REQA ne réveille que les cartes en état IDLE: une carte déjà lue (donc
    # passée en READY) n'y répond plus, et un badge laissé sur le lecteur
    # semblait avoir disparu. WUPA (0x52) réveille aussi celles-là, ce qui
    # permet de suivre la PRÉSENCE d'un badge posé.
    REQALL = 0x52
    ANTICOLL = 0x93

    def __init__(self, spi, cs, rst):
        self.spi = spi
        self.cs = cs
        self.rst = rst
        self.cs.value(1)
        self.rst.value(1)
        self.init()

    # --- accès registres ---------------------------------------------------
    def _wreg(self, reg, val):
        self.cs.value(0)
        self.spi.write(bytes(((reg << 1) & 0x7E, val & 0xFF)))
        self.cs.value(1)

    def _rreg(self, reg):
        self.cs.value(0)
        self.spi.write(bytes((((reg << 1) & 0x7E) | 0x80,)))
        val = self.spi.read(1)
        self.cs.value(1)
        return val[0]

    def _sflags(self, reg, mask):
        self._wreg(reg, self._rreg(reg) | mask)

    def _cflags(self, reg, mask):
        self._wreg(reg, self._rreg(reg) & (~mask & 0xFF))

    # --- initialisation ----------------------------------------------------
    def init(self):
        self.reset()
        self._wreg(0x2A, 0x8D)      # TModeReg
        self._wreg(0x2B, 0x3E)      # TPrescalerReg
        self._wreg(0x2D, 30)        # TReloadReg (poids faible)
        self._wreg(0x2C, 0)         # TReloadReg (poids fort)
        self._wreg(0x15, 0x40)      # TxASKReg: modulation 100 % ASK
        self._wreg(0x11, 0x3D)      # ModeReg: préréglage CRC 0x6363
        self.antenna_on()

    def reset(self):
        self._wreg(0x01, 0x0F)      # CommandReg: SoftReset

    def antenna_on(self, on=True):
        if on:
            if ~(self._rreg(0x14) & 0x03):
                self._sflags(0x14, 0x03)    # TxControlReg
        else:
            self._cflags(0x14, 0x03)

    def version(self):
        """Registre VersionReg. 0x91/0x92 = MFRC522 authentique.

        0x00 ou 0xFF signalent un module muet : câblage, alimentation, ou
        interface non réglée sur SPI.
        """
        return self._rreg(0x37)

    # --- dialogue avec la carte -------------------------------------------
    def _tocard(self, cmd, send):
        recv = []
        bits = irq_en = wait_irq = n = 0

        if cmd == 0x0E:                     # MFAuthent
            irq_en, wait_irq = 0x12, 0x10
        elif cmd == 0x0C:                   # Transceive
            irq_en, wait_irq = 0x77, 0x30

        self._wreg(0x02, irq_en | 0x80)     # ComIEnReg
        self._cflags(0x04, 0x80)            # ComIrqReg
        self._sflags(0x0A, 0x80)            # FIFOLevelReg: vider la FIFO
        self._wreg(0x01, 0x00)              # Idle

        for c in send:
            self._wreg(0x09, c)             # FIFODataReg
        self._wreg(0x01, cmd)
        if cmd == 0x0C:
            self._sflags(0x0D, 0x80)        # BitFramingReg: StartSend

        # Attente de fin de commande.
        #
        # L'idiome répandu `if ~((i != 0) and ~(n & 0x01) and ~(n & wait_irq))`
        # est un piège : le `and` absorbe le terme du timer, seul `n & wait_irq`
        # décide vraiment. Or SANS CARTE c'est le bit TimerIRq (0x01) qui se
        # lève, jamais 0x30 — la boucle enchaînait donc ses 2000 lectures SPI à
        # chaque scrutation, ce qui bloquait la boucle principale du contrôleur
        # pendant plus de 100 ms et rendait les boutons inutilisables.
        i = 2000
        timeout = False
        while i:
            n = self._rreg(0x04)        # ComIrqReg
            i -= 1
            if n & wait_irq:            # commande terminée
                break
            if n & 0x01:                # TimerIRq: délai expiré, pas de carte
                timeout = True
                break

        self._cflags(0x0D, 0x80)
        if timeout:
            return self.NOTAGERR, [], 0

        if i:
            if (self._rreg(0x06) & 0x1B) == 0x00:      # ErrorReg
                status = self.OK
                if n & irq_en & 0x01:
                    status = self.NOTAGERR
                elif cmd == 0x0C:
                    n = self._rreg(0x0A)               # FIFOLevel
                    lbits = self._rreg(0x0C) & 0x07    # ControlReg
                    bits = (n - 1) * 8 + lbits if lbits else n * 8
                    n = 1 if n == 0 else (16 if n > 16 else n)
                    for _ in range(n):
                        recv.append(self._rreg(0x09))
            else:
                status = self.ERR
        else:
            status = self.ERR
        return status, recv, bits

    def request(self, mode=REQIDL):
        """Détecte la présence d'une carte dans le champ."""
        self._wreg(0x0D, 0x07)              # BitFramingReg: 7 bits
        status, recv, bits = self._tocard(0x0C, [mode])
        if status != self.OK or bits != 0x10:
            status = self.ERR
        return status, bits

    def anticoll(self):
        """Renvoie l'UID (4 octets + BCC) de la carte présente."""
        self._wreg(0x0D, 0x00)
        status, recv, _ = self._tocard(0x0C, [self.ANTICOLL, 0x20])
        if status == self.OK:
            if len(recv) == 5:
                checksum = 0
                for i in range(4):
                    checksum ^= recv[i]
                if checksum != recv[4]:
                    status = self.ERR       # UID corrompu: on le jette
            else:
                status = self.ERR
        return status, recv
