# ir_receive

Lire un signal infrarouge

## Description
Interroge la sortie numérique d'un récepteur infrarouge (TSOP, XY-MK-5V, etc.).
Ces petits modules DIY se câblent simplement sur 3,3V, la masse et un GPIO.
Le bloc renvoie l'état du signal décodé par le module, pratique pour détecter
les impulsions d'une télécommande ou synchroniser un apprentissage LIRC.

## Entrées
- **PIN**: field_number

## Sortie
- **Boolean**: `True` lorsque le module voit un train d'impulsions infrarouges
