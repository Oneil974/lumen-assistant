# rpi_rgb_led

Control a three-channel RGB LED.

## Description
Set the colour of an RGB LED (or any three-channel light) by providing BCM pins for red, green and blue. The block outputs a PWM signal on each channel, handles common cathode or common anode wiring, and lets you tune the PWM frequency.

## Entrées
- **R_PIN**: field_number – BCM pin for the red channel.
- **G_PIN**: field_number – BCM pin for the green channel.
- **B_PIN**: field_number – BCM pin for the blue channel.
- **COLOR**: field_colour – desired colour (hex value) converted to duty cycles.
- **FREQ**: field_number – PWM frequency in Hz (default 100, minimum 1).
- **COMMON**: field_dropdown – wiring type (cathode or anode) to automatically invert the duty cycle when required.

## Sortie
- Aucune
