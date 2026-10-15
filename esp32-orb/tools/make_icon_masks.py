#!/usr/bin/env python3
"""Convertit les exports JPEG en masques 1 bit sans fond pour MicroPython."""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def mask(path, size):
    image = Image.open(path).convert("RGB").resize((size, size), Image.Resampling.LANCZOS)
    bits = []
    for r, g, b in image.getdata():
        # Les pictogrammes sont blancs ; les fonds sont volontairement saturés.
        bits.append(max(r, g, b) > 155 and max(r, g, b) - min(r, g, b) < 72)
    rows = []
    for y in range(size):
        for x0 in range(0, size, 8):
            value = 0
            for bit in range(8):
                x = x0 + bit
                if x < size and bits[y * size + x]:
                    value |= 1 << bit
            rows.append(value)
    return bytes(rows)


groups = {
    "MENU_ICONS": (ROOT / "img" / "menu", 20),
    "APP_ICONS": (ROOT / "img" / "apps", 18),
}
lines = ["# Généré par tools/make_icon_masks.py — ne pas modifier à la main."]
for variable, (folder, size) in groups.items():
    lines.append("%s_SIZE = %d" % (variable, size))
    lines.append("%s = {" % variable)
    for path in sorted(folder.glob("*.jpg")):
        lines.append("    %r: %r," % (path.stem, mask(path, size)))
    lines.append("}")
(ROOT / "icon_masks.py").write_text("\n".join(lines) + "\n", encoding="utf-8")
