# -*- coding: utf-8 -*-
# Palettes de l'orbe Lumen — look "sphère de verre + aurora contenue".
#
#   base   = corps sombre de la sphère (verre)
#   rim    = liseré de verre sur le bord (reflet clair)
#   glow   = halo externe diffus
#   aurora = dégradé horizontal (gauche -> droite) du blob coloré central
#   bars   = couleur des deux barres d'état
#
# ⚠️ 3e copie des couleurs (après orb.js / main.js) : garder synchronisé.

THEMES = {
    "aurora": {
        "base": (10, 12, 18),
        "rim":  (70, 82, 108),
        "glow": (30, 60, 80),
        "aurora": [(20, 230, 150), (25, 120, 245), (150, 55, 245), (245, 45, 150)],
        "bars": (240, 242, 248),
    },
    "violet": {
        "base": (12, 8, 20),
        "rim":  (95, 75, 120),
        "glow": (60, 30, 90),
        "aurora": [(150, 90, 235), (110, 70, 230), (200, 90, 220), (235, 130, 200)],
        "bars": (245, 240, 250),
    },
    "ember": {
        "base": (18, 10, 8),
        "rim":  (120, 80, 55),
        "glow": (90, 40, 15),
        "aurora": [(255, 180, 90), (240, 120, 40), (220, 70, 40), (255, 150, 70)],
        "bars": (250, 244, 235),
    },
    "raspberry": {
        "base": (20, 9, 14),
        "rim":  (125, 75, 95),
        "glow": (95, 30, 60),
        "aurora": [(255, 190, 214), (236, 120, 160), (212, 84, 127), (255, 160, 196)],
        "bars": (252, 242, 246),
    },
    "ocean": {
        "base": (8, 12, 20),
        "rim":  (60, 90, 125),
        "glow": (20, 60, 95),
        "aurora": [(80, 210, 220), (40, 140, 230), (60, 90, 210), (120, 200, 245)],
        "bars": (240, 246, 250),
    },
    "mono": {
        "base": (12, 13, 16),
        "rim":  (90, 95, 110),
        "glow": (45, 50, 60),
        "aurora": [(200, 205, 220), (150, 160, 180), (110, 120, 145), (210, 214, 226)],
        "bars": (245, 246, 250),
    },
}
