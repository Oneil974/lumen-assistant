"""Contrôleur Lumen local pour ESP32 / Pico W.

Encodeur: agit sur le modèle, la voix ou la couleur des LEDs; son poussoir
choisit laquelle de ces trois fonctions est active (appui long = tout arrêter).
Potentiomètre: volume ordinateur (commande HID au bridge Desktop).
Boutons: Backend (court = backend suivant, long = charger le modèle en RAM),
Micro (court = dictée, long = nouvelle conversation) et Mode (mode de
discussion).
LEDs WS2812B: état de Lumen (écoute, réflexion, réponse).
Lecteur RFID: envoie l'UID du badge; Lumen décide de l'action associée.
"""
import gc
import time
import network
try:
    import uasyncio as asyncio
except ImportError:
    import asyncio
import config as cfg
try:
    import config_local as _local
    for _name in dir(_local):
        if _name.isupper():
            setattr(cfg, _name, getattr(_local, _name))
except ImportError:
    pass
if getattr(cfg, "IS_PICO", False) and cfg.EPD_SPI_ID not in (0, 1):
    # Récupération d'un ancien config_local ESP32 copié sur un Pico W.
    print("Invalid RP2 SPI profile; restoring Pico W defaults")
    cfg.EPD_SPI_ID = 1
    cfg.EPD_PIN_SCK = 10
    cfg.EPD_PIN_MOSI = 11
    cfg.EPD_PIN_CS = 9
    cfg.EPD_PIN_DC = 8
    cfg.EPD_PIN_RST = 12
    cfg.EPD_PIN_BUSY = 13
    cfg.ENCODER_MODEL_A = 2
    cfg.ENCODER_MODEL_B = 3
    cfg.VOLUME_ADC_PIN = 26
    cfg.VOLUME_ADC_ATTENUATION = False
    cfg.BUTTON_BACKEND = 14
    cfg.BUTTON_MIC = 15
    cfg.BUTTON_MODE = 16
    cfg.BUTTON_ENCODER = 17
    cfg.LED_PIN = 18
if hasattr(cfg, "EXTRA_LLAMA_MODELS"):
    cfg.MODELS["llama"] = tuple(cfg.MODELS.get("llama", ())) + tuple(
        cfg.EXTRA_LLAMA_MODELS
    )
from input import Encoder, Button, Potentiometer
from net import State, Link
from ui import UI
from leds import Leds
from rfid import Rfid


def wifi(state):
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    try:
        wlan.config(dhcp_hostname=cfg.WIFI_HOSTNAME)
    except Exception:
        pass
    if not wlan.isconnected():
        wlan.connect(cfg.WIFI_SSID, cfg.WIFI_PASSWORD)
        for _ in range(100):
            if wlan.isconnected():
                break
            time.sleep_ms(100)
    if wlan.isconnected():
        state.ip = wlan.ifconfig()[0]
        print("Lumen controller:", state.ip, "port", cfg.TCP_PORT)
    return wlan


async def turn_encoder(state, link, leds, step):
    """Applique un cran de molette à la fonction actuellement sélectionnée."""
    if state.encoder_fn == "led":
        state.led_color = leds.cycle_color(step)
        return                                  # réglage purement local
    if state.encoder_fn == "voice":
        choices = state.voices or (state.voice,)
        if not choices or not choices[0]:
            return                              # aucune voix installée
        index = choices.index(state.voice) if state.voice in choices else 0
        state.voice = choices[(index + step) % len(choices)]
        await link.send({"type": "command", "cmd": "set_voice",
                         "voice": state.voice})
        return
    # Défaut: le modèle. state.models est le catalogue poussé par Lumen, avec
    # repli sur config.py. Le modèle courant peut malgré tout en être absent:
    # sans ce garde-fou, choices.index() lèverait une ValueError qui tuerait la
    # boucle, donc plus aucune commande ni aucun rafraîchissement d'écran.
    choices = state.models.get(state.backend) or (state.model,)
    # On mémorise la POSITION, pas seulement le nom. Si l'application renvoie
    # un nom qui ne figure pas au catalogue (suffixe retiré, modèle lancé
    # hors de Lumen…), repartir de l'index 0 enfermait la molette sur les deux
    # premières entrées. En gardant la position atteinte, on parcourt toujours
    # la liste entière.
    if state.model in choices:
        index = choices.index(state.model)
    else:
        index = state.model_index
    index = (index + step) % len(choices)
    state.model_index = index
    state.model = choices[index]
    await link.send({"type": "command", "cmd": "set_model",
                     "model": state.model, "backend": state.backend})


async def run(state, link):
    ui = UI(cfg)
    model = Encoder(
        cfg.ENCODER_MODEL_A, cfg.ENCODER_MODEL_B,
        getattr(cfg, "ENCODER_STEPS_PER_DETENT", 4),
        getattr(cfg, "ENCODER_REVERSED", False),
    )
    volume = Potentiometer(
        cfg.VOLUME_ADC_PIN,
        getattr(cfg, "VOLUME_DEADBAND", 2),
        getattr(cfg, "VOLUME_REVERSED", False),
        getattr(cfg, "VOLUME_ADC_ATTENUATION", True),
    )
    leds = Leds(cfg)
    reader = Rfid(cfg)
    long_ms = getattr(cfg, "BUTTON_LONG_MS", 700)
    # Backend et Mic distinguent court et long: ils émettent "click"/"long" au
    # lieu de "down". Les autres gardent la réaction immédiate à l'appui.
    buttons = {"backend": Button(cfg.BUTTON_BACKEND, cfg.ACTIVE_LOW, long_ms=long_ms),
               "mic": Button(cfg.BUTTON_MIC, cfg.ACTIVE_LOW, long_ms=long_ms),
               "mode": Button(cfg.BUTTON_MODE, cfg.ACTIVE_LOW)}
    encoder_pin = getattr(cfg, "BUTTON_ENCODER", None)
    if encoder_pin is not None:
        buttons["encoder"] = Button(encoder_pin, cfg.ACTIVE_LOW, long_ms=long_ms)
    print("encodeur: A=%d B=%d, %d transitions/cran, interruptions %s"
          % (cfg.ENCODER_MODEL_A, cfg.ENCODER_MODEL_B,
             getattr(cfg, "ENCODER_STEPS_PER_DETENT", 4),
             "actives" if model.irq_ok else "INDISPONIBLES"))
    last_draw = 0
    last_gc = 0
    last_notify = state.notify_seq
    while True:
        # Le tas d'un Pico W est vite fragmenté (asyncio, JSON, framebuffer,
        # LEDs, RFID). Un passage régulier du ramasse-miettes évite le
        # MemoryError qui faisait redémarrer la carte: écran qui clignote à la
        # ré-initialisation, et état repartant des valeurs de config.py.
        now = time.ticks_ms()
        if time.ticks_diff(now, last_gc) >= 5000:
            last_gc = now
            gc.collect()
            libre = gc.mem_free()
            if libre < 24000:
                print("memoire faible: %d octets libres" % libre)
        step = model.read()
        if step:
            print("encodeur: %+d cran(s) sur %s (%d transitions)"
                  % (step, state.encoder_fn, model.transitions))
            await turn_encoder(state, link, leds, step)
        new_volume = volume.read()
        if new_volume is not None and new_volume != state.volume:
            delta = new_volume - state.volume
            state.volume = new_volume
            await link.send({"type": "command", "cmd": "hid_volume", "value": state.volume, "delta": delta})
        for name, button in buttons.items():
            event = button.event()
            if event is None or event == "up":
                continue
            if name == "backend" and event == "click":
                backends = cfg.BACKENDS
                index = backends.index(state.backend) if state.backend in backends else -1
                state.backend = backends[(index + 1) % len(backends)]
                state.model = (state.models.get(state.backend) or ("--",))[0]
                await link.send({"type": "command", "cmd": "set_backend",
                                 "backend": state.backend, "model": state.model})
            elif name == "backend" and event == "long":
                # Retour immédiat à l'écran et aux LEDs: le chargement dure
                # plusieurs secondes et l'application confirmera ensuite.
                state.mode = "loading"
                await link.send({"type": "command", "cmd": "load_model",
                                 "model": state.model, "backend": state.backend})
            elif name == "mic" and event == "click":
                await link.send({"type": "command", "cmd": "dictation"})
            elif name == "mic" and event == "long":
                # Nouvelle conversation: l'équivalent du bouton « Nettoyer la
                # discussion » de la barre Lumen.
                await link.send({"type": "command", "cmd": "new_chat"})
            elif name == "mode" and event == "down":
                modes = getattr(cfg, "CHAT_MODES", ("chat",))
                index = modes.index(state.chat_mode) if state.chat_mode in modes else -1
                state.chat_mode = modes[(index + 1) % len(modes)]
                await link.send({"type": "command", "cmd": "set_mode",
                                 "mode": state.chat_mode})
            elif name == "encoder" and event == "click":
                functions = getattr(cfg, "ENCODER_FUNCTIONS", ("model",))
                index = (functions.index(state.encoder_fn)
                         if state.encoder_fn in functions else -1)
                state.encoder_fn = functions[(index + 1) % len(functions)]
            elif name == "encoder" and event == "long":
                # Tout arrêter: lecture vocale, génération, workflow en cours.
                state.mode = "idle"
                await link.send({"type": "command", "cmd": "stop"})
        # Le mode association est piloté par Lumen: tant qu'un écran attend un
        # badge, le lecteur réémet celui qui est posé.
        reader.set_pairing(state.rfid_pairing)
        event = reader.poll()
        if event:
            kind, uid = event
            if kind == "badge":
                # Le contrôleur ne sait PAS à quoi ce badge correspond, et c'est
                # voulu: la table des associations vit dans Lumen, qui peut donc
                # gagner de nouvelles actions sans qu'on reflashe la carte.
                print("RFID: badge", uid)
                state.rfid_present = True
                state.mode = "loading"
                await link.send({"type": "command", "cmd": "rfid", "uid": uid})
            else:
                # Retrait: aucun UID n'est transmis, il n'y a rien à résoudre.
                # C'est ce qui permet de reposer le même badge pour rejouer son
                # action, et à Lumen de réagir au retrait s'il le souhaite.
                print("RFID: badge retire")
                state.rfid_present = False
                await link.send({"type": "command", "cmd": "rfid_removed"})

        # Notification lumineuse: le lien TCP ne fait qu'incrémenter un
        # compteur, c'est ici qu'on déclenche le pulse, car l'objet Leds
        # n'appartient qu'à cette boucle.
        if state.notify_seq != last_notify:
            last_notify = state.notify_seq
            print("notification:", state.notify_text or "(sans texte)")
            leds.notify(state.notify_color or None)

        # Les LEDs suivent l'état poussé par Lumen, à chaque tour de boucle:
        # c'est l'indication instantanée, là où l'e-paper met plusieurs
        # centaines de ms à se redessiner.
        leds.set_state(state.mode)
        leds.tick()
        now = time.ticks_ms()
        if time.ticks_diff(now, last_draw) >= 150:
            ui.render(state)
            last_draw = now
        await asyncio.sleep_ms(cfg.POLL_MS)


async def _main():
    state = State(cfg)
    print("Hardware profile:", "Pico W / RP2" if getattr(cfg, "IS_PICO", False) else "ESP32")
    # Un bouton câblé sur un GPIO que le firmware ne surveille pas est
    # indétectable autrement: il ne se passe simplement rien.
    print("Entrees: encodeur A=%d B=%d SW=%s, pot=%d, boutons backend=%d mic=%d mode=%d, LEDs=%s"
          % (cfg.ENCODER_MODEL_A, cfg.ENCODER_MODEL_B,
             getattr(cfg, "BUTTON_ENCODER", None), cfg.VOLUME_ADC_PIN,
             cfg.BUTTON_BACKEND, cfg.BUTTON_MIC, cfg.BUTTON_MODE,
             getattr(cfg, "LED_PIN", None)))
    print("RFID: CS=%s SCK=%s MOSI=%s MISO=%s RST=%s"
          % (getattr(cfg, "RFID_PIN_CS", None), getattr(cfg, "RFID_PIN_SCK", None),
             getattr(cfg, "RFID_PIN_MOSI", None), getattr(cfg, "RFID_PIN_MISO", None),
             getattr(cfg, "RFID_PIN_RST", None)))
    gc.collect()
    print("memoire libre au demarrage: %d octets" % gc.mem_free())
    wifi(state)
    link = Link(state, cfg.TCP_PORT)
    await asyncio.gather(link.serve(), run(state, link))

try:
    asyncio.run(_main())
except KeyboardInterrupt:
    pass
