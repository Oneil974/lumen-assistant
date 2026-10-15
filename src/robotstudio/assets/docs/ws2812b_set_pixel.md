# ws2812b_set_pixel

Contrôle un pixel précis d'un ruban WS2812B.

## Description
Configure la couleur et la luminosité d'un seul pixel sur un ruban WS2812B connecté à une broche GPIO.

## Entrées
- **PIN** : field_number – broche GPIO utilisée.
- **COUNT** : field_number – nombre total de LEDs dans le ruban.
- **INDEX** : field_number – index du pixel à modifier (0 = première LED).
- **COLOR** : field_colour – couleur à appliquer.
- **BRIGHTNESS** : field_number – luminosité (0 à 255).

## Sortie
- Aucune
