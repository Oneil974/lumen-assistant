# -*- coding: utf-8 -*-
# Configuration de l'avatar Lumen — ESP32-S3-LCD-1.28 (écran rond GC9A01).
#
# Valeurs alignées sur le firmware voiture qui fonctionne (Backup_ESPROUND) :
# driver C `gc9a01` figé dans le firmware, SPI(2) @ 80 MHz, polarity=0.

# ---------------------------------------------------------------- Écran / SPI
SPI_ID   = 2               # ⚠️ bus 2 (pas 1) — comme tft_config.py
SPI_BAUD = 80_000_000      # 80 MHz, valeur connue-bonne sur cette carte
PIN_SCK  = 10
PIN_MOSI = 11
PIN_DC   = 8
PIN_CS   = 9
PIN_RST  = 14
PIN_BL   = 2               # rétroéclairage (mets None si non câblé)
ROTATION = 0               # orientation d'origine (comme le firmware voiture)
SCREEN   = 240             # écran 240x240 (disque rond)
FIRMWARE_VERSION = "0.3.0"

# ---------------------------------------------------------------- Orbe
# Rendu par cercles concentriques dessinés en C (fill_circle) : rapide,
# aucun buffer géant, aucun besoin de PSRAM.
MARGIN            = 4       # marge (px) entre le bord de l'orbe et l'écran
RINGS             = 28      # nb de cercles concentriques (dégradé du halo)
FPS_CAP           = 30
BREATHE_PERIOD_MS = 4200    # durée d'un cycle de respiration en veille
BREATHE_MIN       = 0.60    # luminosité mini de la respiration (0..1)

DEFAULT_THEME = "aurora"

# ---------------------------------------------------------------- Réseau
# Optionnel : Lumen OS pousse l'état (thème / mode / niveau audio) en TCP JSON.
WIFI_ENABLE = False
WIFI_SSID = "CHANGE_ME"
WIFI_PASS = "CHANGE_ME"
NET_PORT    = 8787

# ---------------------------------------------------------------- Robustesse / veille
# L'orbe est un objet permanent : on le rend « vivant tout seul ».
DIM_AFTER_MS     = 30_000    # baisse la luminosité après ce délai d'inactivité
STANDBY_AFTER_MS = 180_000   # écran éteint (veille) après ce délai (réseau gardé)
DIM_LEVEL        = 25        # luminosité réduite en veille douce (%)
QUIET_START      = 22        # heures « nuit » : auto-dim/veille renforcés
QUIET_END        = 7
WATCHDOG_MS      = 30_000    # watchdog matériel (0 = désactivé)

# ---------------------------------------------------------------- Horloge (NTP)
NTP_ENABLE  = True          # synchronise l'heure via NTP au démarrage
TZ_OFFSET   = 2             # décalage horaire vs UTC (France été = +2)
IDLE_CLOCK  = True          # affiche l'heure + prochain rappel sur l'accueil

# ---------------------------------------------------------------- LEDs WS2812B
# Bandeau de 3-4 LEDs qui scintillent aux couleurs de l'orbe (dégradé aurora
# qui se déplace). Alim 3.3V OK pour peu de LEDs à faible luminosité ;
# 330 Ω en série sur la data + condensateur d'alim recommandés.
LED_ENABLE     = True
LED_PIN        = 21         # ⚠️ une GPIO LIBRE exposée (adapte à ton câblage)
LED_COUNT      = 4
LED_BRIGHTNESS = 40         # % (garde bas pour le 3.3V et l'effet scintillement)
LED_SPEED      = 0.6        # vitesse du déplacement des couleurs
LED_SPAN       = 0.6        # étalement du dégradé sur le bandeau (0..1)
