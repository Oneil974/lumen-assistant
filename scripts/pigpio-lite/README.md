# pigpio-lite — remplaçant de pigpiod pour Raspberry Pi 5

Sur le **Raspberry Pi 5**, le GPIO passe par le southbridge **RP1** et
`pigpio`/`pigpiod` ne fonctionne plus. `pigpio-lite` est un petit démon Python,
au-dessus de **lgpio** (supporté sur Pi 5), qui réimplémente le sous-ensemble de
commandes `pigs` utilisé par les blocs Raspberry Pi de Lumen/Fluxo. Les blocs
fonctionnent ainsi **sans aucune modification**.

## Contenu

| Fichier | Rôle |
|---------|------|
| `pigpio_lite.py` | le démon (socket Unix `/run/pigpio-lite.sock`), état GPIO/PWM/I²C/SPI persistant |
| `pigs` | shim client compatible, à installer dans le PATH (prioritaire sur le vrai `pigs`) |
| `pigpio-lite.service` | unité systemd |
| `install.sh` | installe le tout (démon + shim + service) |

## Installation

Sur le Pi 5 :

```sh
cd scripts/pigpio-lite
sudo ./install.sh
```

Test rapide :

```sh
pigs m 17 w && pigs w 17 1 && pigs r 17   # → 1
```

## Commandes prises en charge

Exactement celles qu'émettent les blocs Fluxo :

- **GPIO** : `m <pin> <r|w>`, `w <pin> <0|1>`, `r <pin>`, `pud <pin> <u|d|o>`
- **PWM / servo** : `p <pin> <0-255>`, `pfs <pin> <freq>`, `s <pin> <pulse_µs>`
- **I²C** : `i2co <bus> <addr> <flags>`, `i2cwb <h> <reg> <val>`, `i2crb <h> <reg>`, `i2cc <h>`
- **SPI** : `spio <chan> <baud> <flags>`, `spix <h> <octets…>`, `spic <h>`

Les broches sont en numérotation **BCM**. L'état (broches réclamées, fréquences PWM,
handles I²C/SPI) est conservé entre les appels — c'est tout l'intérêt d'un démon
plutôt qu'un CLI éphémère.

## Limites / pistes

- Couvre le périmètre des blocs Lumen, pas toute l'API pigpio.
- 1-Wire n'en dépend pas (lecture directe via `/sys/bus/w1/devices/`).
- `lgpio` choisit `gpiochip0` puis `gpiochip4` (selon la version de Raspberry Pi OS).
- Si tu préfères repartir de zéro, le protocole « une ligne `cmd args` → `OK [val]` /
  `ERR msg` » est trivial à réimplémenter.
