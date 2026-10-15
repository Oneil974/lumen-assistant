# rpi_gpio_read

Read the logic level of a GPIO.

## Description
Configure a pin as an input (with optional pull-up or pull-down resistor) and return its current HIGH/LOW state.

## Entrées
- **PIN**: field_number – BCM pin number to monitor.
- **PULL**: field_dropdown – choose the internal resistor configuration (none, pull-up, pull-down).

## Sortie
- Boolean – `True` when the pin is HIGH, otherwise `False`.
