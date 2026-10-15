#!/usr/bin/env python3
"""Exporte les icônes SVG de Lumen en JPEG RGB pour le driver GC9A01."""

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]

MENU = {
    "settings": ("#4b69b4", '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a2 2 0 0 0 .4 2.2l-2.6 2.6a2 2 0 0 0-2.2-.4L14 22h-4l-1-2.6a2 2 0 0 0-2.2.4l-2.6-2.6a2 2 0 0 0 .4-2.2L2 14v-4l2.6-1a2 2 0 0 0-.4-2.2l2.6-2.6A2 2 0 0 0 9 4.6L10 2h4l1 2.6a2 2 0 0 0 2.2-.4l2.6 2.6a2 2 0 0 0-.4 2.2l2.6 1v4z"/>'),
    "apps": ("#1ea57d", '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>'),
    "conversation": ("#2d8cbe", '<path d="M4 5h16v11H9l-5 4z"/><circle cx="9" cy="10.5" r="1" fill="white"/><circle cx="12" cy="10.5" r="1" fill="white"/><circle cx="15" cy="10.5" r="1" fill="white"/>'),
    "dictation": ("#d73778", '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>'),
    "agent": ("#9141d2", '<rect x="5" y="7" width="14" height="11" rx="4"/><circle cx="9" cy="12" r="1.4" fill="white"/><circle cx="15" cy="12" r="1.4" fill="white"/><path d="M12 7V4M9 20h6"/>'),
    "sleep": ("#d7aa23", '<path d="M12 2v9M6.3 5.5a8 8 0 1 0 11.4 0"/>'),
    "notifications": ("#be3791", '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M14 21h-4"/>'),
}

APPS = {
    "agents": '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    "designer": '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    "calendar": '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><circle cx="9" cy="14" r="1" fill="white"/><circle cx="15" cy="14" r="1" fill="white"/>',
    "notes": '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    "domotique": '<path d="M3 11l9-7 9 7M5 10v10h14V10"/><rect x="10" y="13" width="4" height="4" rx="1"/>',
    "games": '<rect x="2" y="7" width="20" height="10" rx="5"/><path d="M7 10v4M5 12h4"/><circle cx="16" cy="11" r="1" fill="white"/><circle cx="19" cy="14" r="1" fill="white"/>',
}


def svg(size, background, body, circular=False):
    attrs = ' stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"'
    for tag in ("path", "rect", "circle", "line"):
        body = body.replace("<" + tag + " ", "<" + tag + attrs + " ")
    backdrop = (f'<rect width="24" height="24" fill="#10131d" stroke="none"/>'
                f'<circle cx="12" cy="12" r="12" fill="{background}" stroke="none"/>') if circular else f'<rect width="24" height="24" fill="{background}" stroke="none"/>'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24">
{backdrop}
<g fill="none">{body}</g>
</svg>'''


def export(group, size, items, circular=False):
    out = ROOT / "img" / group
    out.mkdir(parents=True, exist_ok=True)
    for name, value in items.items():
        bg, body = value if isinstance(value, tuple) else ("#10131d", value)
        src = out / (name + ".svg")
        dst = out / (name + ".jpg")
        src.write_text(svg(size, bg, body, circular), encoding="utf-8")
        subprocess.run(["node", str(ROOT / "tools" / "rasterize_svg.cjs"),
                        str(src), str(dst), str(size)], check=True)
        src.unlink()


export("menu", 32, MENU, True)
export("apps", 24, APPS)
