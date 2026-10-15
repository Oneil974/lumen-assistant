import re, math

def oklch_to_rgb(L, C, H):
    h = math.radians(H); a = C*math.cos(h); b = C*math.sin(h)
    l_ = L + 0.3963377774*a + 0.2158037573*b
    m_ = L - 0.1055613458*a - 0.0638541728*b
    s_ = L - 0.0894841775*a - 1.2914855480*b
    l, m, s = l_**3, m_**3, s_**3
    r = 4.0767416621*l - 3.3077115913*m + 0.2309699292*s
    g = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s
    bl = -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
    return [min(1, max(0, v)) for v in (r, g, bl)]

def rel_lum(rgb_lin):
    r, g, b = rgb_lin
    return 0.2126*r + 0.7152*g + 0.0722*b

def contrast(L, C, H, bg_lin_lum):
    lum = rel_lum(oklch_to_rgb(L, C, H))
    a, b = max(lum, bg_lin_lum), min(lum, bg_lin_lum)
    return (a + 0.05) / (b + 0.05)

WHITE = rel_lum(oklch_to_rgb(1, 0, 0))          # fond clair
DARK  = rel_lum(oklch_to_rgb(0.145, 0, 0))      # fond sombre

def ink_light(L, C, H):
    """Assombrit juste assez pour atteindre 4.5:1 sur fond clair."""
    lo, hi = 0.20, L
    if contrast(L, C, H, WHITE) >= 4.5:
        return round(L, 4), round(C, 4)
    for _ in range(40):
        mid = (lo + hi) / 2
        if contrast(mid, C, H, WHITE) >= 4.5: lo = mid
        else: hi = mid
    return round(lo, 4), round(C, 4)

def ink_dark(L, C, H):
    """Éclaircit juste assez pour atteindre 4.5:1 sur fond sombre."""
    lo, hi = L, 0.99
    if contrast(L, C, H, DARK) >= 4.5:
        return round(L, 4), round(C, 4)
    for _ in range(40):
        mid = (lo + hi) / 2
        if contrast(mid, C, H, DARK) >= 4.5: hi = mid
        else: lo = mid
    return round(hi, 4), round(C, 4)

src = open('src/lib/tokens.css').read()
rows = re.findall(r'\[data-ui-accent="([^"]+)"\]\s*\{\s*--accent-primary:\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)', src)
light, dark = [], []
for name, L, C, H in rows:
    L, C, H = float(L), float(C), float(H)
    ll, lc = ink_light(L, C, H)
    dl, dc = ink_dark(L, C, H)
    light.append(f'[data-ui-accent="{name}"] {{ --accent-ink: oklch({ll} {lc} {H}); }}')
    dark.append((name, dl, dc, H))

out = ['/* ── Encre d\'accent ────────────────────────────────────────────────────────',
       '   La couleur d\'action sert aussi de couleur de TEXTE (intitulés, onglet actif,',
       '   badges). Or un accent clair — chartreuse, citron, les pastels de l\'orbe —',
       '   est illisible en texte sur fond clair, alors qu\'il reste parfait en aplat.',
       '   `--accent-ink` est donc la MÊME teinte, ramenée à un contraste de 4,5:1 sur',
       '   le fond du thème courant (assombrie en clair, éclaircie en sombre). Les',
       '   valeurs sont calculées, pas choisies à l\'œil : cf. scripts/gen-accent-ink.py.',
       '   Repli sur --primary quand aucun accent n\'est posé (les palettes de base ont',
       '   déjà une couleur d\'action lisible). */',
       ':root { --accent-ink: var(--primary); }', '']
out += light
out += ['', '/* Fond sombre : la même teinte, éclaircie. Deux écritures — le choix explicite',
        '   (data-dt-theme) et le réglage système — comme partout ailleurs dans ce fichier. */']
for name, dl, dc, H in dark:
    out.append(f'[data-dt-theme="dark"][data-ui-accent="{name}"] {{ --accent-ink: oklch({dl} {dc} {H}); }}')
out.append('@media (prefers-color-scheme: dark) {')
for name, dl, dc, H in dark:
    out.append(f'  :root:not([data-dt-theme="light"])[data-ui-accent="{name}"] {{ --accent-ink: oklch({dl} {dc} {H}); }}')
out.append('}')
print('\n'.join(out))
