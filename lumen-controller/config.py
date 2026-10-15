# Configuration par défaut du contrôleur Lumen (ESP32 ou Pico W).
# Copiez ce fichier en config_local.py et modifiez uniquement les valeurs locales.
import sys

IS_PICO = sys.platform == "rp2"

WIFI_SSID = "CHANGE_ME"
WIFI_PASSWORD = "CHANGE_ME"
WIFI_HOSTNAME = "lumen-controller"
TCP_PORT = 8787

# Backends et modèles affichés par la molette centrale.
BACKENDS = ("ollama", "llama", "apple", "api")
MODELS = {
    "ollama": ("qwen3:8b", "llama3.2", "gemma3:4b"),
    "llama": (
        "LFM2.5-350M-Q4_K_M.gguf",
        "LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
        "LFM2.5-1.2B-Thinking-Q4_K_M.gguf",
        "gemma-4-E2B_q4_0-it.gguf",
    ),
    "apple": ("apple-intelligence",),
    "api": ("gpt-4o-mini", "claude-sonnet", "gemini-2.5-flash"),
}

# GPIO de l'interface. Le profil est choisi automatiquement.
ENCODER_MODEL_A = 2 if IS_PICO else 32
ENCODER_MODEL_B = 3 if IS_PICO else 33
# Transitions par cran. 4 pour un EC11 classique (un cran = un cycle complet).
# Certains encodeurs en donnent 2 : si un cran fait avancer de deux valeurs,
# mettre 2. Si deux crans sont nécessaires pour avancer d'une valeur, mettre 8.
ENCODER_STEPS_PER_DETENT = 4
ENCODER_REVERSED = False
VOLUME_ADC_PIN = 26 if IS_PICO else 34
VOLUME_ADC_ATTENUATION = not IS_PICO
VOLUME_DEADBAND = 2
VOLUME_REVERSED = False
# Backend: appui court = backend suivant, appui LONG = charger le modèle en RAM.
BUTTON_BACKEND = 14 if IS_PICO else 4
BUTTON_MIC = 15 if IS_PICO else 5
# Mode de discussion (ancien bouton Desktop, même broche).
BUTTON_MODE = 16 if IS_PICO else 18
# Poussoir intégré de l'encodeur (broche SW d'un KY-040): change ce sur quoi
# agit la molette. Mettre à None pour ne pas l'utiliser.
BUTTON_ENCODER = 17 if IS_PICO else 19
# Durée à partir de laquelle un appui est considéré comme long.
BUTTON_LONG_MS = 700

# Ce sur quoi agit la molette, dans l'ordre du cycle du poussoir.
ENCODER_FUNCTIONS = ("model", "voice", "led")

# Modes de discussion parcourus par le bouton Mode. Doivent exister côté Lumen
# (OLLAMA_MODES dans src/main.js). "workflow" est exclu: il exige de désigner
# en plus un workflow Fluxo, ce qu'un bouton seul ne permet pas.
CHAT_MODES = ("chat", "router", "tools", "docs")

# Bandeau WS2812B d'indication d'état. LED_PIN = None pour s'en passer.
LED_PIN = 18 if IS_PICO else 27
# 3 LEDs : ~60 mA par WS2812B en blanc plein, soit déjà ~200 mA à trois, ce que
# l'alimentation USB de la carte encaisse. Au-delà, alimentation 5 V dédiée.
LED_COUNT = 3
# Pourcentage: un WS2812B à pleine puissance tire ~60 mA par LED, ce qui
# dépasse ce que fournit le régulateur 3V3 d'un Pico W.
LED_BRIGHTNESS = 50
LED_COLOR_INDEX = 0
# Intervalle minimal entre deux écritures du bandeau. Chaque write() bit-bang
# les LEDs interruptions DÉSACTIVÉES : trop fréquent, il ferait perdre des
# fronts à l'encodeur et aux boutons.
LED_MIN_INTERVAL_MS = 40
# Notifications lumineuses. La couleur est normalement imposée par Lumen
# (Réglages → Notifications) et envoyée avec chaque notification; celle-ci ne
# sert que si l'application n'en fournit aucune. Le pulse est volontairement
# rapide et proche de l'extinction: il doit se distinguer des couleurs d'état.
NOTIFY_COLOR = "#ff9f0a"
NOTIFY_MS = 4000

# Lecteur RFID MFRC522 (13,56 MHz). RFID_PIN_CS = None pour s'en passer.
# Bus SPI0 sur Pico W : l'écran occupe SPI1, aucune ligne n'est partagée.
# Le contrôleur n'envoie que l'UID lu ; c'est Lumen qui décide de l'action.
RFID_PIN_CS = 5 if IS_PICO else 21
RFID_SPI_ID = 0 if IS_PICO else 1
RFID_PIN_SCK = 6 if IS_PICO else 22
RFID_PIN_MOSI = 7 if IS_PICO else 23
RFID_PIN_MISO = 4 if IS_PICO else 25
RFID_PIN_RST = 22 if IS_PICO else 26
RFID_SPI_BAUD = 1_000_000
# Un badge posé sur le lecteur n'est envoyé qu'UNE fois : il faut le retirer
# pour rejouer son action. Ce délai ne sert donc qu'au mode ASSOCIATION, où le
# badge présent est réémis pour qu'un écran des Réglages puisse le capturer.
RFID_REPEAT_MS = 2_500
# Scrutations vides consécutives avant de déclarer le badge retiré. Une carte
# posée n'est pas vue à tous les tours : à 1, la présence clignoterait et
# l'action se rejouerait sans arrêt.
RFID_ABSENT_POLLS = 3
# Intervalle de scrutation du lecteur. Une scrutation sans carte attend
# l'expiration du timer du MFRC522 (~15 ms) : l'appeler à chaque tour de boucle
# grèverait la réactivité des boutons pour rien.
RFID_POLL_MS = 250
ACTIVE_LOW = True

# Affichage. Valeurs: "epaper_2in13_v4", "ssd1306" ou "none".
DISPLAY_TYPE = "epaper_2in13_v4"
# L'autocollant du module cible indique explicitement V4.
EPD_PANEL_DRIVER = "v4"

# Waveshare 2.13inch e-Paper HAT V4, noir/blanc, 250x122, SPI.
# ESP32: VSPI/SPI(2). Pico W: SPI(1). Les broches associées sont sélectionnées
# automatiquement et peuvent toujours être surchargées dans config_local.py.
EPD_SPI_ID = 1 if IS_PICO else 2
# 2 MHz est plus tolérant aux fils Dupont longs; le HAT accepte davantage.
EPD_SPI_BAUD = 2_000_000
EPD_PIN_SCK = 10 if IS_PICO else 14
EPD_PIN_MOSI = 11 if IS_PICO else 13
EPD_PIN_CS = 9 if IS_PICO else 15
EPD_PIN_DC = 8 if IS_PICO else 2
EPD_PIN_RST = 12 if IS_PICO else 16
EPD_PIN_BUSY = 13 if IS_PICO else 17
EPD_ROTATION = 180
EPD_MIN_REFRESH_MS = 700
EPD_FULL_REFRESH_EVERY = 20
# Sommeil profond de la DALLE après ce délai sans changement. Waveshare
# déconseille de la laisser sous tension en continu. L'image reste affichée:
# un e-paper la conserve sans alimentation. 0 pour désactiver.
EPD_SLEEP_AFTER_MS = 60_000
EPD_BUSY_TIMEOUT_MS = 15_000
EPD_BUSY_ACTIVE = 1
# Les HAT Rev 2.1 coupent l'alimentation si RST reste bas trop longtemps.
EPD_RESET_LOW_US = 2_000
# Sur Rev 2.1, un RST bas prolongé coupe l'alimentation du driver. Cette durée
# n'est utilisée qu'en récupération si BUSY est déjà actif avant l'init.
EPD_POWER_RECOVERY_MS = 20

# Ancien écran OLED optionnel.
I2C_ID = 0
I2C_SDA = 21
I2C_SCL = 22
DISPLAY_WIDTH = 128
DISPLAY_HEIGHT = 64
DISPLAY_ADDRESS = 0x3C

STATE_FILE = "lumen_state.json"
POLL_MS = 80
HEARTBEAT_MS = 2000
