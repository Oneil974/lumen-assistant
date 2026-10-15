"""Diagnostic de l'encodeur rotatif, quand rien n'est sérigraphié dessus.

Depuis l'ordinateur: mpremote connect auto run encoder_test.py

Trois étapes:
  1. IDENTIFICATION  — scrute toutes les broches libres pendant que vous
     tournez, puis pendant que vous appuyez. Les broches qui bougent sont vos
     A / B / SW, quelles que soient les couleurs de fils.
  2. DÉCODAGE        — affiche en direct les transitions et les crans décodés
     avec les broches de config.py, pour confirmer le câblage et le sens.
  3. RÉSUMÉ          — les lignes à recopier dans config_local.py.

Les broches déjà occupées (écran, LEDs, boutons) ne sont jamais scrutées: les
configurer en entrée perturberait l'affichage.
"""
import time
from machine import Pin

import config as cfg

try:
    import config_local as local
    for name in dir(local):
        if name.isupper():
            setattr(cfg, name, getattr(local, name))
except ImportError:
    pass

IS_PICO = getattr(cfg, "IS_PICO", False)


def occupees():
    """Broches à ne surtout pas toucher pendant le test."""
    noms = ("EPD_PIN_SCK", "EPD_PIN_MOSI", "EPD_PIN_CS", "EPD_PIN_DC",
            "EPD_PIN_RST", "EPD_PIN_BUSY", "LED_PIN", "VOLUME_ADC_PIN",
            "BUTTON_BACKEND", "BUTTON_MIC", "BUTTON_MODE")
    return set(p for p in (getattr(cfg, n, None) for n in noms) if p is not None)


def candidates():
    if IS_PICO:
        # GP23/24/25/29 sont réservés en interne sur un Pico W.
        tous = list(range(0, 23)) + [26, 27, 28]
    else:
        # GPIO d'usage général d'un ESP32 DevKit. On évite les broches de
        # démarrage (0, 2, 12, 15) et les broches internes de la flash.
        tous = [4, 5, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33,
                34, 35, 36, 39]
    interdites = occupees()
    libres = [g for g in tous if g not in interdites]
    # Les broches actuellement configurées restent testées: c'est justement ce
    # qu'on veut confirmer ou infirmer.
    for nom in ("ENCODER_MODEL_A", "ENCODER_MODEL_B", "BUTTON_ENCODER"):
        broche = getattr(cfg, nom, None)
        if broche is not None and broche not in libres:
            libres.append(broche)
    return sorted(libres)


def surveiller(broches, secondes, consigne):
    """Compte les changements de niveau sur chaque broche."""
    print("\n>>> %s" % consigne)
    for n in range(3, 0, -1):
        print("    %d..." % n)
        time.sleep(1)
    print("    MAINTENANT, pendant %d secondes." % secondes)

    pins = {}
    for g in broches:
        try:
            pins[g] = Pin(g, Pin.IN, Pin.PULL_UP)
        except (ValueError, TypeError):
            continue                       # broche inexistante sur ce port
    etats = dict((g, p.value()) for g, p in pins.items())
    compte = dict((g, 0) for g in pins)

    fin = time.ticks_add(time.ticks_ms(), secondes * 1000)
    while time.ticks_diff(fin, time.ticks_ms()) > 0:
        for g, p in pins.items():
            v = p.value()
            if v != etats[g]:
                etats[g] = v
                compte[g] += 1
    actifs = sorted(((c, g) for g, c in compte.items() if c), reverse=True)
    if not actifs:
        print("    AUCUNE broche n'a bougé.")
        return []
    for c, g in actifs:
        print("    GPIO%-2d : %4d changements" % (g, c))
    return [g for _, g in actifs]


def decoder(pin_a, pin_b, secondes=15):
    print("\n>>> Décodage avec A=GPIO%d  B=GPIO%d pendant %d s." % (pin_a, pin_b, secondes))
    print("    Tournez d'un cran dans un sens, puis dans l'autre.")
    from input import Encoder
    enc = Encoder(pin_a, pin_b,
                  getattr(cfg, "ENCODER_STEPS_PER_DETENT", 4),
                  getattr(cfg, "ENCODER_REVERSED", False))
    print("    interruptions:", "actives" if enc.irq_ok else "INDISPONIBLES")
    total = 0
    fin = time.ticks_add(time.ticks_ms(), secondes * 1000)
    dernier = 0
    while time.ticks_diff(fin, time.ticks_ms()) > 0:
        step = enc.read()
        if step:
            total += step
            print("    cran %+d  -> position %+d   (AB=%02b, %d transitions)"
                  % (step, total, enc.last, enc.transitions))
        elif enc.transitions != dernier:
            dernier = enc.transitions
            print("    ... %d transitions, cran incomplet (accumulateur %+d)"
                  % (enc.transitions, enc.acc))
        time.sleep_ms(50)
    return enc, total


print("=" * 58)
print("Diagnostic encodeur — profil %s" % ("Pico W / RP2" if IS_PICO else "ESP32"))
print("config.py actuel : A=GPIO%s  B=GPIO%s  SW=GPIO%s"
      % (getattr(cfg, "ENCODER_MODEL_A", "?"),
         getattr(cfg, "ENCODER_MODEL_B", "?"),
         getattr(cfg, "BUTTON_ENCODER", "?")))
print("=" * 58)
print("\nRappel: le commun de l'encodeur (C, ou GND sur un KY-040) DOIT aller")
print("à la masse de la carte. Sans cela aucune broche ne bougera.")

broches = candidates()
print("\nBroches scrutées : %s" % ", ".join("GPIO%d" % g for g in broches))

tourne = surveiller(broches, 6, "TOURNEZ la molette, lentement, dans un seul sens.")
appui = surveiller(broches, 5, "APPUYEZ sur l'axe de l'encodeur, plusieurs fois.")

# Le poussoir apparaît dans les deux relevés si on a tourné en appuyant: on le
# retire de la liste des candidats A/B.
sw = appui[0] if appui else None
ab = [g for g in tourne if g != sw][:2]

print("\n" + "=" * 58)
if len(ab) < 2:
    print("RÉSULTAT : moins de deux broches actives à la rotation.")
    print("  - le commun de l'encodeur n'est probablement pas à GND ;")
    print("  - ou A/B sont câblés sur des broches non scrutées ci-dessus ;")
    print("  - ou l'encodeur est défectueux.")
else:
    a, b = ab[0], ab[1]
    print("RÉSULTAT : A et B semblent être GPIO%d et GPIO%d." % (a, b))
    if sw:
        print("           Le poussoir semble être GPIO%d." % sw)
    enc, total = decoder(a, b)
    print("\n" + "=" * 58)
    if enc.transitions == 0:
        print("Aucune transition pendant le décodage. Vérifiez le câblage.")
    elif total == 0:
        print("Des transitions (%d) mais aucun cran complet." % enc.transitions)
        print("Essayez ENCODER_STEPS_PER_DETENT = 2 dans config_local.py.")
    else:
        print("Décodage fonctionnel : %d transitions, %+d crans nets." % (enc.transitions, total))
        print("Si le sens est inversé, ajoutez ENCODER_REVERSED = True.")
    print("\nÀ recopier dans config_local.py :")
    print("    ENCODER_MODEL_A = %d" % a)
    print("    ENCODER_MODEL_B = %d" % b)
    if sw:
        print("    BUTTON_ENCODER = %d" % sw)
print("=" * 58)
