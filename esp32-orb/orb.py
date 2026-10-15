# -*- coding: utf-8 -*-
# Rendu de l'orbe Lumen : sphère de verre sombre + blob "aurora" contenu au
# centre + liseré de verre + deux barres d'état. Composé dans un framebuffer
# RAM puis envoyé en UN blit_buffer -> fluide, sans scintillement.
#
# - Le blob aurora (dégradé horizontal doux, masque elliptique) est PRÉ-CALCULÉ
#   une fois par thème dans un petit framebuffer (sprite), puis blitté à chaque
#   frame avec un léger balancement (effet "vivant") -> pas de recalcul lourd.
# - framebuf RGB565 = little-endian : on inverse les octets des couleurs (_fbc).

import math
import time
import framebuf
import gc
import os
import gc9a01 as lcd

try:
    from fonts import Inter16, Inter24, Inter32
except ImportError:
    Inter16 = Inter24 = Inter32 = None
try:
    from icon_masks import MENU_ICONS, MENU_ICONS_SIZE, APP_ICONS, APP_ICONS_SIZE
except ImportError:
    MENU_ICONS = APP_ICONS = {}
    MENU_ICONS_SIZE = APP_ICONS_SIZE = 0


def _clamp(v):
    v = int(v)
    return 0 if v < 0 else (255 if v > 255 else v)


def _fbc(r, g, b):
    # color565 avec octets inversés pour framebuf -> panneau
    c = lcd.color565(_clamp(r), _clamp(g), _clamp(b))
    return ((c & 0xFF) << 8) | (c >> 8)


def _lerp(c0, c1, u):
    return (c0[0] + (c1[0] - c0[0]) * u,
            c0[1] + (c1[1] - c0[1]) * u,
            c0[2] + (c1[2] - c0[2]) * u)


def _grad(stops, t):
    # stops = liste de couleurs réparties uniformément sur [0,1]
    n = len(stops)
    if t <= 0:
        return stops[0]
    if t >= 1:
        return stops[-1]
    p = t * (n - 1)
    i = int(p)
    return _lerp(stops[i], stops[i + 1], p - i)


class Orb:
    # Interface locale inspirée de la maquette : l'orbe reste l'écran
    # d'accueil, le bouton ouvre le menu, les glissements naviguent.
    MENU = ("Réglages", "Infos", "Conversation", "Écoute", "Agent", "Veille", "Notifications")
    SETTINGS = ("Luminosité", "Connexion", "Info", "Thème")
    # « Infos » = écrans qui RÉCUPÈRENT et affichent des infos de la plateforme
    # (id de pull, libellé). Chacun envoie {"cmd":"pull","what":id} à Lumen.
    APPS = (("sensors", "Domotique"), ("agenda", "Agenda"),
            ("tasks", "Taches"), ("status", "Plateforme"))
    MENU_ASSETS = ("settings", "apps", "conversation", "dictation", "agent", "sleep", "notifications")

    def __init__(self, tft, cfg, themes, backlight=None):
        self.tft = tft
        self.cfg = cfg
        self.themes = themes
        self.R = cfg.SCREEN // 2 - cfg.MARGIN

        # Framebuffer principal = carré englobant la sphère
        self.D = 2 * self.R + 2
        self.lc = self.R + 1                 # centre dans le buffer
        self.ox = cfg.SCREEN // 2 - self.lc
        self.oy = cfg.SCREEN // 2 - self.lc
        self.buf = bytearray(self.D * self.D * 2)
        self.fb = framebuf.FrameBuffer(self.buf, self.D, self.D, framebuf.RGB565)

        # Buffer d'animation central. La sphère et son liseré sont statiques ;
        # seuls l'aurore et les yeux nécessitent un transfert à chaque frame.
        self.AD = 148
        self.ac = self.AD // 2
        self.aox = cfg.SCREEN // 2 - self.ac
        self.aoy = cfg.SCREEN // 2 - self.ac
        self.anim_buf = bytearray(self.AD * self.AD * 2)
        self.anim_fb = framebuf.FrameBuffer(self.anim_buf, self.AD, self.AD, framebuf.RGB565)

        # Sprite aurora (pré-calculé par thème) — blob ROND
        self.AW = int(1.15 * self.R)
        self.AH = int(1.15 * self.R)
        self.abuf = bytearray(self.AW * self.AH * 2)
        self.afb = framebuf.FrameBuffer(self.abuf, self.AW, self.AH, framebuf.RGB565)

        # Yeux (barres arrondies)
        self.br = max(4, self.R // 18)     # rayon des bouts arrondis
        self.bw = 2 * self.br + 1          # largeur d'un œil (alignée aux caps)
        self.bh = int(self.R * 0.42)       # hauteur max des yeux
        self.gap = self.R // 5             # écart entre les deux yeux

        self.mode = "idle"
        self.level = 0.0

        # interactions (tactile / IMU)
        self.look_x = 0.0
        self.look_y = 0.0
        self._blink_t = None       # clignement forcé (tap)
        self._surprise_t = None    # yeux écarquillés (secousse / double-tap)
        self._sleep = False        # yeux fermés (appui long)
        self._ip = None            # IP affichée à la secousse
        self._names = list(themes.keys())
        self._ni = self._names.index(cfg.DEFAULT_THEME) if cfg.DEFAULT_THEME in self._names else 0
        self.backlight = backlight
        self.brightness = 100
        self.screen = "home"       # home, menu, settings, adjust, notice, sleep
        self.menu_i = 0
        self.setting_i = 0
        self.app_i = 0
        self._saved_notice = None
        self.notice_scroll = 0
        self.message_scroll = 0
        self.agent_active = False
        self.agent_count = 0
        self.agent_task = "Aucune tache en cours"
        self.agent_id = ""
        self._notice_until = 0
        self.connected = False

        # robustesse / veille / horloge / domotique
        self.last_activity = time.ticks_ms()
        self.standby = False
        self._hhmm = None          # heure "HH:MM" (NTP ou poussée par Lumen)
        self._time_push_t = 0
        self._agenda = None        # prochain rappel : {"label","time"}
        self._sensors = []         # capteurs domotique poussés par Lumen
        self.sensor_scroll = 0
        self._events = []          # agenda / prochains rappels
        self._tasks = []           # tâches / inbox agents
        self._status = {}          # état plateforme (modèle IA, agent, non-lus…)
        self.info_scroll = 0       # défilement des listes agenda/tâches
        self._ui_texts = []
        self._ui_assets = []
        self._ui_dirty = True
        self._home_static_dirty = True
        self._last_render_screen = None

        self._theme_name = None
        self._th = None
        self.bg565 = 0
        self._base_fb = 0
        self._rim_fb = 0
        self._rim2_fb = 0
        self._glow_fb = 0
        self._bars_fb = 0
        self.set_theme(cfg.DEFAULT_THEME)

    # ---------------------------------------------------------------- thèmes
    def set_theme(self, name):
        if name not in self.themes or name == self._theme_name:
            return
        self._theme_name = name
        th = self.themes[name]
        self._th = th
        base = th["base"]
        self.bg565 = lcd.color565(0, 0, 0)
        self._base_fb = _fbc(*base)
        # liseré discret (pas un anneau bleu criard)
        self._rim_fb = _fbc(*[c * 0.55 for c in th["rim"]])
        self._rim2_fb = _fbc(*[c * 0.28 for c in th["rim"]])
        self._glow_fb = _fbc(*th["glow"])
        self._bars_fb = _fbc(*th["bars"])
        self._build_aurora()
        if hasattr(self, "_ui_dirty"):
            self._ui_dirty = True
            self._home_static_dirty = True

    def _build_aurora(self):
        # Pré-calcule le blob : dégradé horizontal + masque elliptique doux,
        # fondu vers la couleur de la sphère (base) aux bords -> blit opaque.
        AW, AH = self.AW, self.AH
        base = self._th["base"]
        stops = self._th["aurora"]
        cx, cy = AW / 2.0, AH / 2.0
        ax, ay = AW / 2.0, AH / 2.0
        fb = self.afb
        for y in range(AH):
            ny = (y - cy) / ay
            for x in range(AW):
                nx = (x - cx) / ax
                e = nx * nx + ny * ny            # distance elliptique²
                if e >= 1.0:
                    col = base
                else:
                    # cœur saturé (plein hue jusqu'à ~55 %), fondu doux au bord
                    if e < 0.55:
                        inten = 1.0
                    else:
                        inten = ((1.0 - e) / 0.45) ** 0.7
                    hue = _grad(stops, x / (AW - 1))
                    col = _lerp(base, hue, inten)
                fb.pixel(x, y, _fbc(*col))

    # ------------------------------------------------------------- animation
    # ---------------------------------------------------------- interactions
    def blink_now(self):
        self._blink_t = time.ticks_ms()

    def surprise(self):
        self._surprise_t = time.ticks_ms()

    def toggle_sleep(self):
        self._sleep = not self._sleep

    def set_connected(self, value):
        value = bool(value)
        if value != self.connected:
            self.connected = value
            self._ui_dirty = True
            self._home_static_dirty = True

    # ------------------------------------------------------- veille / horloge
    def note_activity(self):
        """À appeler sur tout tap/geste/message : réveille et repousse la veille."""
        self.last_activity = time.ticks_ms()
        if self.standby:
            self.set_standby(False)

    def set_standby(self, value):
        value = bool(value)
        if value == self.standby:
            return
        self.standby = value
        if not value:                       # réveil : tout re-dessiner
            if self.backlight:
                self.backlight.set(self.brightness)
            self._home_static_dirty = True
            self._ui_dirty = True

    def set_time(self, hhmm, pushed=False):
        hhmm = str(hhmm or "")[:5]
        if pushed:
            self._time_push_t = time.ticks_ms()
        if hhmm and hhmm != self._hhmm:
            self._hhmm = hhmm
            self._home_static_dirty = True   # l'accueil réaffiche l'heure

    def time_pushed_recently(self):
        return self._time_push_t and time.ticks_diff(time.ticks_ms(), self._time_push_t) < 120_000

    def set_agenda(self, label, at=None):
        label = (str(label)[:22] if label else None)
        self._agenda = {"label": label, "time": str(at or "")[:5]} if label else None
        self._home_static_dirty = True

    def set_sensors(self, sensors):
        self._sensors = sensors if isinstance(sensors, (list, tuple)) else []
        if self.screen == "sensors":
            self._ui_dirty = True

    def set_events(self, events):
        self._events = list(events) if isinstance(events, (list, tuple)) else []
        # le 1er événement alimente aussi l'horloge d'accueil (prochain rappel)
        if self._events and isinstance(self._events[0], dict):
            e0 = self._events[0]
            self.set_agenda(e0.get("label"), e0.get("time"))
        if self.screen == "agenda":
            self._ui_dirty = True

    def set_tasks(self, tasks):
        self._tasks = list(tasks) if isinstance(tasks, (list, tuple)) else []
        if self.screen == "tasks":
            self._ui_dirty = True

    def set_status(self, status):
        self._status = status if isinstance(status, dict) else {}
        if self.screen == "status":
            self._ui_dirty = True

    def notify(self, text, count=1, source="Lumen", success=True, timestamp=""):
        self._saved_notice = {
            "text": str(text or "Notification")[:700],
            "count": int(count or 1),
            "source": str(source or "Lumen")[:20],
            "success": bool(success),
            "timestamp": str(timestamp or "")[:16],
        }
        self.notice_scroll = 0
        self._notice_until = time.ticks_ms() + 5000
        self.screen = "notice"
        self._ui_dirty = True

    def show_message(self, text):
        self._last_message = str(text or "Aucun message")[:700]
        self.message_scroll = 0
        self.screen = "message"
        self._ui_dirty = True

    def show_agent(self, active=False, count=0, task=None, agent_id=None):
        self.agent_active = bool(active)
        self.agent_count = int(count or 0)
        self.agent_task = str(task or ("Aucune tache en cours" if not active else "Tache en cours"))[:80]
        self.agent_id = str(agent_id or "")[:24]
        self.screen = "agent"
        self._ui_dirty = True

    def handle_touch(self, x, y):
        """Active directement l'élément situé sous le doigt (coord. 240×240)."""
        if x is None or y is None:
            return self.handle_gesture(5)
        c = self.cfg.SCREEN // 2
        if self.screen == "home":
            return self.handle_gesture(5)
        if self.screen == "menu":
            positions = ((c,48),(c+58,76),(c+58,148),(c,180),(c-58,148),(c-58,76),(c,c))
            best = None; best_d = 31 * 31
            for i, (cx, cy) in enumerate(positions):
                d = (x-cx)*(x-cx) + (y-cy)*(y-cy)
                if d <= best_d: best, best_d = i, d
            if best is not None:
                self.menu_i = best
                self._ui_dirty = True
                return self.handle_gesture(5)
            return None
        if self.screen in ("settings", "apps"):
            # Quatre lignes visibles : centres Y = 69, 99, 129, 159.
            slot = int((y - (c-52) + 15) // 30)
            if 0 <= slot < 4 and 28 <= x <= 212:
                delta = slot - 1
                if self.screen == "settings":
                    self.setting_i = (self.setting_i + delta) % len(self.SETTINGS)
                else:
                    self.app_i = (self.app_i + delta) % len(self.APPS)
                self._ui_dirty = True
                return self.handle_gesture(5)
            if y < 48 and x < 90:
                return self.handle_gesture(3)
            return None
        if self.screen == "adjust":
            if y < 48 and x < 90: return self.handle_gesture(3)
            if x < c-25: self._adjust(-1)
            elif x > c+25: self._adjust(1)
            self._ui_dirty = True
            return None
        if y < 55 and x < 100:
            return self.handle_gesture(3)
        return self.handle_gesture(5)

    def handle_gesture(self, gesture):
        """Retourne une commande Lumen éventuelle pour le geste local."""
        if gesture == 12:  # appui long : veille depuis n'importe quel écran
            self.screen = "sleep" if self.screen != "sleep" else "home"
            self._sleep = self.screen == "sleep"
            self._ui_dirty = True
            return "sleep" if self._sleep else "wake"
        if self.screen == "sleep":
            return None
        if gesture == 5:
            if self.screen == "home": self.screen = "menu"
            elif self.screen == "menu":
                if self.menu_i == 0: self.screen = "settings"
                elif self.menu_i == 1: self.screen = "apps"
                elif self.menu_i == 2: return "conversation"
                elif self.menu_i == 3: return "dictation"
                elif self.menu_i == 4: return "agent"
                elif self.menu_i == 5: self.screen = "sleep"
                else: self.screen = "notice"
            elif self.screen == "settings":
                if self.setting_i == 1: self.screen = "connection"
                elif self.setting_i == 2: self.screen = "info"
                else: self.screen = "adjust"
            elif self.screen == "adjust": self.screen = "settings"
            elif self.screen == "apps":
                what = self.APPS[self.app_i][0]     # sensors|agenda|tasks|status
                self.screen = what                  # écran info LOCAL
                self.sensor_scroll = 0
                self.info_scroll = 0
                self._ui_dirty = True
                return "pull:" + what               # demande les données à Lumen
            else: self.screen = "home"
        elif gesture == 3:  # gauche = retour
            if self.screen in ("sensors", "agenda", "tasks", "status"):
                self.screen = "apps"
            else:
                self.screen = "home" if self.screen in ("menu", "settings", "notice", "message", "agent", "apps") else "settings"
        elif gesture == 4:
            if self.screen == "menu": self.menu_i = (self.menu_i + 1) % len(self.MENU)
            elif self.screen == "settings": self.setting_i = (self.setting_i + 1) % len(self.SETTINGS)
            elif self.screen == "apps": self.app_i = (self.app_i + 1) % len(self.APPS)
            elif self.screen == "adjust": self._adjust(1)
        elif gesture == 1:
            if self.screen == "menu": self.menu_i = (self.menu_i - 1) % len(self.MENU)
            elif self.screen == "settings": self.setting_i = (self.setting_i - 1) % len(self.SETTINGS)
            elif self.screen == "apps": self.app_i = (self.app_i - 1) % len(self.APPS)
            # Défilement par page avec deux lignes de recouvrement : on garde
            # le contexte sans ne révéler qu'une seule nouvelle ligne.
            elif self.screen == "message": self.message_scroll += 4
            elif self.screen == "notice": self.notice_scroll += 3
            elif self.screen == "sensors": self.sensor_scroll += 4
            elif self.screen in ("agenda", "tasks"): self.info_scroll += 4
            elif self.screen == "adjust": self._adjust(1)
        elif gesture == 2:
            if self.screen == "adjust": self._adjust(-1)
            elif self.screen == "message": self.message_scroll = max(0, self.message_scroll - 4)
            elif self.screen == "notice": self.notice_scroll = max(0, self.notice_scroll - 3)
            elif self.screen == "sensors": self.sensor_scroll = max(0, self.sensor_scroll - 4)
            elif self.screen in ("agenda", "tasks"): self.info_scroll = max(0, self.info_scroll - 4)
        self._ui_dirty = True
        return None

    def _adjust(self, direction):
        if self.setting_i == 0:
            self.brightness = max(10, min(100, self.brightness + direction * 10))
            if self.backlight: self.backlight.set(self.brightness)
        elif self.setting_i == 3:
            self._ni = (self._ni + direction) % len(self._names)
            self.set_theme(self._names[self._ni])

    def _label(self, s, y, color=None, scale=1, cx=None):
        # Le driver Waveshare sait dessiner les fontes bitmap Inter. On les
        # dessine après le blit pour garder le rendu de l'orbe en framebuffer.
        self._ui_texts.append((str(s), y, color or _fbc(235, 240, 250), scale,
                               self.cfg.SCREEN // 2 if cx is None else cx))

    def _ascii(self, s):
        # Inter16/24/32 fournis par le firmware voiture couvrent l'ASCII,
        # mais pas les caractères accentués. Fallback sûr pour MicroPython.
        table = {"é":"e", "è":"e", "ê":"e", "ë":"e", "à":"a", "â":"a", "ä":"a", "î":"i", "ï":"i", "ô":"o", "ö":"o", "ù":"u", "û":"u", "ü":"u", "ç":"c", "É":"E", "À":"A", "’":"'", "–":"-"}
        return "".join(table.get(ch, ch) for ch in s)

    def _draw_ui_texts(self):
        if not hasattr(self.tft, "write"):
            return
        for text, y, color, scale, center_x in self._ui_texts:
            font = Inter24 if scale == 2 else Inter16
            if font is None:
                continue
            text = self._ascii(text)
            try:
                width = self.tft.write_width(font, text)
            except Exception:
                width = sum(font.WIDTHS[font.MAP.find(ch)] if ch in font.MAP else 6 for ch in text)
            x = max(2, center_x - width // 2)
            rgb = ((color & 0xFF) << 8) | (color >> 8)
            self.tft.write(font, text, x, max(0, y - font.HEIGHT // 2), rgb)

    def _asset_exists(self, path):
        try:
            os.stat(path)
            return True
        except OSError:
            return False

    def _draw_ui_assets(self):
        if not hasattr(self.tft, "jpg"):
            return
        for path, x, y in self._ui_assets:
            try:
                self.tft.jpg(path, x, y, lcd.FAST)
            except Exception:
                pass

    def _draw_mask(self, data, size, x, y, color):
        """Dessine un masque HLSB directement dans le framebuffer, sans fond."""
        stride = (size + 7) // 8
        for yy in range(size):
            row = yy * stride
            for xx in range(size):
                if data[row + (xx >> 3)] & (1 << (xx & 7)):
                    self.fb.pixel(x + xx, y + yy, color)

    def _wrap(self, text, width=22):
        lines=[]; line=""
        for word in str(text or "").split():
            while len(word) > width:
                if line: lines.append(line); line=""
                lines.append(word[:width]); word=word[width:]
            if len(line)+len(word)+(1 if line else 0) > width:
                if line: lines.append(line)
                line=word
            else:
                line=(line+" "+word).strip()
        if line: lines.append(line)
        return lines or ["--"]

    def _render_ui(self):
        fb, c, R = self.fb, self.lc, self.R
        self._ui_texts = []
        self._ui_assets = []
        white, blue, dim = _fbc(235,240,250), _fbc(70,170,255), _fbc(100,110,135)
        fb.ellipse(c, c, R, R, self._base_fb, True)

        if self.screen == "menu":
            # Six boutons autour d'un bouton central, comme le mockup. Les
            # coordonnées restent dans la zone sûre du disque 240×240.
            positions = ((c,48),(c+58,76),(c+58,148),(c,180),(c-58,148),(c-58,76),(c,c))
            colors = ((75,105,180),(30,165,125),(45,140,190),
                      (215,55,120),(145,65,210),(215,170,35),(190,55,145))
            initials = ("R", "A", "C", "E", "G", "V", "N")
            for i in range(len(self.MENU)):
                x, y = positions[i]; selected = i == self.menu_i
                rr = 24
                fb.ellipse(x,y,rr,rr,_fbc(*colors[i]),True)
                icon = MENU_ICONS.get(self.MENU_ASSETS[i])
                if icon: self._draw_mask(icon, MENU_ICONS_SIZE, x-MENU_ICONS_SIZE//2, y-MENU_ICONS_SIZE//2, white)
                else: self._label(initials[i], y, white, 1, x)
            # La sélection est indiquée sans modifier la taille de la bulle.
            sx, sy = positions[self.menu_i]
            fb.ellipse(sx, sy+29, 2, 2, _fbc(80,205,255), True)
            self._label(self.MENU[self.menu_i], c+94, blue, 1)
        elif self.screen in ("settings", "adjust"):
            self._label("<  Réglages", c-84, blue, 1)
            if self.screen == "settings":
                for n in range(-1, 3):
                    i=(self.setting_i+n)%len(self.SETTINGS); y=c-22+n*30
                    col=blue if n==0 else white
                    self._pill(y, n == 0)
                    self._label(self.SETTINGS[i], y, col, 1)
            else:
                name=self.SETTINGS[self.setting_i]
                if self.setting_i == 0: val = self.brightness
                elif self.setting_i == 3: val = self._theme_name
                elif self.setting_i == 1: val = "OK" if self.connected else "--"
                else: val = "240x240"
                self._label(name, c-72, white, 1); fb.ellipse(c,c,48,48,blue,False)
                suffix = "%" if self.setting_i == 0 else ""
                self._label(str(val)+suffix, c+4, white, 2)
                self._label("glisser pour ajuster", c+74, dim, 1)
        elif self.screen == "apps":
            self._label("<  Infos", c-84, blue, 1)
            for n in range(-1, 3):
                i=(self.app_i+n)%len(self.APPS); y=c-22+n*30
                self._pill(y, n == 0)
                app_id, app_name = self.APPS[i]
                icon = APP_ICONS.get(app_id)
                if icon:
                    self._draw_mask(icon, APP_ICONS_SIZE, c-66-APP_ICONS_SIZE//2, y-APP_ICONS_SIZE//2, white)
                else:
                    fb.ellipse(c-66, y, 9, 9, blue if n == 0 else dim, True)
                    self._label(app_name[0], y, white, 1, c-66)
                self._label(app_name, y, blue if n == 0 else white, 1, c+8)
            self._label("appuyer pour afficher", c+88, dim, 1)
        elif self.screen == "connection":
            self._label("<  Connexion", c-76, blue, 1)
            self._label("Wi-Fi  connecte" if self._ip else "Wi-Fi  absent", c-30, white, 1)
            self._label("SSID", c+2, dim, 1)
            self._label(getattr(self.cfg, "WIFI_SSID", "--")[:20], c+27, white, 1)
            self._label("IP  " + (self._ip or "--"), c+57, white, 1)
            self._label("Lumen  "+("connecte" if self.connected else "absent"), c+84, blue, 1)
        elif self.screen == "info":
            self._label("<  Informations", c-76, blue, 1)
            free = gc.mem_free(); total = max(1, gc.mem_alloc() + free)
            try:
                fs = os.statvfs("/")
                storage_free = fs[0] * fs[3]
                storage_total = fs[0] * fs[2]
                storage = "%d%% libre" % (storage_free * 100 // max(1, storage_total))
            except Exception:
                storage = "--"
            self._label("Firmware  v" + getattr(self.cfg, "FIRMWARE_VERSION", "?"), c-30, white, 1)
            self._label("Stockage  " + storage, c+2, white, 1)
            self._label("RAM  %d%% libre" % (free*100//total), c+34, white, 1)
            self._label("ESP32-S3", c+66, white, 1)
            self._label("GC9A01  240x240", c+90, dim, 1)
        elif self.screen == "notice":
            self._label("<  Notification", c-78, blue, 1)
            n = self._saved_notice or {"text":"Aucune notification","count":0,"source":"Lumen","success":True,"timestamp":""}
            state = "OK" if n["success"] else "ERREUR"
            self._label(n["source"] + "  " + state, c-42, _fbc(55,225,145) if n["success"] else _fbc(255,90,105), 1)
            meta = "%d nouvelle(s)" % n["count"]
            if n["timestamp"]: meta += "  " + n["timestamp"]
            self._label(meta, c-18, dim, 1)
            lines = self._wrap(n["text"])
            max_scroll = max(0, len(lines)-5)
            self.notice_scroll = min(self.notice_scroll, max_scroll)
            for i, line in enumerate(lines[self.notice_scroll:self.notice_scroll+5]):
                self._label(line, c+10+i*21, white, 1)
            if max_scroll:
                pages = (max_scroll + 2) // 3 + 1
                page = min(pages, self.notice_scroll // 3 + 1)
                self._label("%d/%d" % (page, pages), c+96, blue, 1)
        elif self.screen == "message":
            self._label("<  Conversation", c-82, blue, 1)
            lines = self._wrap(getattr(self, "_last_message", "Aucun message"))
            max_scroll = max(0, len(lines)-6)
            self.message_scroll = min(self.message_scroll, max_scroll)
            for i, line in enumerate(lines[self.message_scroll:self.message_scroll+6]):
                self._label(line, c-44+i*22, white, 1)
            if max_scroll:
                pages = (max_scroll + 3) // 4 + 1
                page = min(pages, self.message_scroll // 4 + 1)
                self._label("%d/%d" % (page, pages), c+96, blue, 1)
        elif self.screen == "agent":
            self._label("<  Agent", c-76, blue, 1)
            ring = _fbc(50,225,145) if self.agent_active else dim
            fb.ellipse(c, c-8, 42, 42, ring, False)
            self._label("ACTIF" if self.agent_active else "REPOS", c-8, white, 1)
            self._label("%d tache(s)" % self.agent_count, c+42, blue, 1)
            words = self.agent_task.split(); line=""; lines=[]
            for word in words:
                if len(line)+len(word)+1 > 22: lines.append(line); line=word
                else: line=(line+" "+word).strip()
                if len(lines) >= 2: break
            if line and len(lines) < 2: lines.append(line)
            for i, line in enumerate(lines): self._label(line, c+68+i*20, white, 1)
        elif self.screen == "sensors":
            self._label("<  Domotique", c-84, blue, 1)
            if not self._sensors:
                self._label("Aucun capteur", c-6, dim, 1)
                self._label("(demande envoyee a Lumen)", c+20, dim, 1)
            else:
                total = len(self._sensors)
                max_scroll = max(0, total - 4)
                if self.sensor_scroll > max_scroll:
                    self.sensor_scroll = max_scroll
                for i, s in enumerate(self._sensors[self.sensor_scroll:self.sensor_scroll+4]):
                    if not isinstance(s, dict):
                        s = {"name": str(s)}
                    y = c - 30 + i * 30
                    self._pill(y, False)
                    parts = []
                    if s.get("temp") is not None:
                        try: parts.append("%.1f C" % float(s["temp"]))
                        except Exception: pass
                    if s.get("hum") is not None:
                        try: parts.append("%d%%" % int(s["hum"]))
                        except Exception: pass
                    val = "  ".join(parts) if parts else str(s.get("value", ""))[:10]
                    self._label(str(s.get("name", "?"))[:12], y, white, 1, c - 38)
                    self._label(val, y, blue, 1, c + 52)
                if max_scroll:
                    self._label("%d/%d" % (self.sensor_scroll + 1, total), c + 92, dim, 1)
        elif self.screen == "agenda":
            self._label("<  Agenda", c-84, blue, 1)
            if not self._events:
                self._label("Rien de prevu", c-6, dim, 1)
            else:
                total = len(self._events)
                if self.info_scroll > max(0, total - 4):
                    self.info_scroll = max(0, total - 4)
                for i, e in enumerate(self._events[self.info_scroll:self.info_scroll+4]):
                    if not isinstance(e, dict):
                        e = {"label": str(e)}
                    y = c - 34 + i * 30
                    when = str(e.get("time", ""))[:5]
                    self._label(when or "--", y, blue, 1, c-72)
                    self._label(str(e.get("label", "?"))[:18], y, white, 1, c+16)
                if total > 4:
                    self._label("%d/%d" % (self.info_scroll + 1, total), c + 92, dim, 1)
        elif self.screen == "tasks":
            self._label("<  Taches", c-84, blue, 1)
            if not self._tasks:
                self._label("Aucune tache", c-6, dim, 1)
            else:
                total = len(self._tasks)
                done = sum(1 for tk in self._tasks if isinstance(tk, dict) and tk.get("done"))
                self._label("%d / %d faites" % (done, total), c-40, dim, 1)
                if self.info_scroll > max(0, total - 3):
                    self.info_scroll = max(0, total - 3)
                for i, tk in enumerate(self._tasks[self.info_scroll:self.info_scroll+3]):
                    if not isinstance(tk, dict):
                        tk = {"text": str(tk)}
                    y = c - 4 + i * 28
                    mark = "x" if tk.get("done") else "o"
                    col = dim if tk.get("done") else white
                    self._label(mark, y, blue, 1, c-78)
                    self._label(str(tk.get("text", "?"))[:20], y, col, 1, c+6)
                if total > 3:
                    self._label("%d/%d" % (self.info_scroll + 1, total), c + 92, dim, 1)
        elif self.screen == "status":
            self._label("<  Plateforme", c-80, blue, 1)
            st = self._status or {}
            lumen_ok = self.connected
            self._label("Lumen  " + ("connecte" if lumen_ok else "absent"),
                        c-34, _fbc(55,225,145) if lumen_ok else _fbc(255,90,105), 1)
            self._label("Modele  " + str(st.get("model", "--"))[:16], c-8, white, 1)
            ag = st.get("agent")
            self._label("Agent  " + ("actif" if ag else "repos") +
                        ("  %d" % st.get("agent_count", 0) if st.get("agent_count") else ""),
                        c+18, white, 1)
            self._label("Non lus  %d" % int(st.get("unread", 0) or 0), c+44, white, 1)
            if st.get("heartbeat") is not None:
                self._label("Heartbeat  " + ("on" if st.get("heartbeat") else "off"), c+70, dim, 1)
        elif self.screen == "sleep":
            self._label("Éteindre l'orbe ?", c-5, white, 1); self._label("appui long", c+28, dim, 1)

        # Indicateur de connexion sur tous les écrans statiques.
        fb.ellipse(c, 9, 3, 3, _fbc(50,235,150) if self.connected else _fbc(100,105,120), True)

    def _pill(self, y, selected):
        col = _fbc(35, 42, 68) if selected else self._base_fb
        fb = self.fb; c = self.lc
        # Capsule de 19 px : les caps ont exactement la demi-épaisseur.
        fb.fill_rect(c-76, y-9, 152, 19, col)
        fb.ellipse(c-76, y, 9, 9, col, True)
        fb.ellipse(c+76, y, 9, 9, col, True)

    def set_ip(self, ip):
        self._ip = ip

    def _draw_text_center(self, s, color, scale, cy):
        # dessine `s` (police 8x8 intégrée) centré horizontalement, mis à l'échelle
        w = len(s) * 8
        tb = bytearray(w * 8 * 2)
        tf = framebuf.FrameBuffer(tb, w, 8, framebuf.RGB565)
        tf.fill(0)
        tf.text(s, 0, 0, 0xFFFF)
        ox = self.lc - (w * scale) // 2
        oy = cy - (8 * scale) // 2
        fb = self.fb
        for yy in range(8):
            for xx in range(w):
                if tf.pixel(xx, yy):
                    fb.fill_rect(ox + xx * scale, oy + yy * scale, scale, scale, color)

    def next_theme(self):
        self._ni = (self._ni + 1) % len(self._names)
        self.set_theme(self._names[self._ni])

    def prev_theme(self):
        self._ni = (self._ni - 1) % len(self._names)
        self.set_theme(self._names[self._ni])

    def look(self, ax, ay):
        # inclinaison (g) -> décalage du regard. Inverse un signe si besoin.
        amp = self.br * 2.2
        tx = ax * amp
        ty = ay * amp
        if tx > amp: tx = amp
        elif tx < -amp: tx = -amp
        if ty > amp: ty = amp
        elif ty < -amp: ty = -amp
        self.look_x = 0.85 * self.look_x + 0.15 * tx
        self.look_y = 0.85 * self.look_y + 0.15 * ty

    def _eye_scale(self):
        if self._surprise_t is not None:
            p = time.ticks_diff(time.ticks_ms(), self._surprise_t)
            if p <= 450:
                return 1.0 + 0.45 * math.sin(p / 450.0 * math.pi)
            self._surprise_t = None
        return 1.0

    def _blink(self):
        now = time.ticks_ms()
        if self._blink_t is not None:                 # clignement forcé (tap)
            p = time.ticks_diff(now, self._blink_t)
            if p <= 260:
                return 1.0 - 0.9 * math.sin(p / 260.0 * math.pi)
            self._blink_t = None
        p = now % 4200                                # clignement périodique
        if p < 220:
            return 1.0 - 0.85 * math.sin(p / 220.0 * math.pi)
        return 1.0

    def _bar_heights(self):
        if self._sleep:                               # yeux fermés
            return self.bw, self.bw
        t = time.ticks_ms() / 1000.0
        es = self._eye_scale()
        if self.mode == "speaking":
            a = self.level
            a = 0.0 if a < 0.0 else (1.0 if a > 1.0 else a)
            h1 = self.bh * (0.35 + 0.65 * a)
            h2 = self.bh * (0.35 + 0.65 * a * (0.6 + 0.4 * abs(math.sin(t * 7))))
        elif self.mode == "listening":
            s = (0.82 + 0.18 * math.sin(t * 3)) * self._blink()
            h1 = h2 = self.bh * s
        else:  # idle : yeux vivants (respiration + clignement)
            s = (0.9 + 0.1 * math.sin(t * 2.1)) * self._blink()
            h1 = h2 = self.bh * s
        return max(int(h1 * es), self.bw), max(int(h2 * es), self.bw)

    def _vbar(self, cx, cy, h, color, fb=None):
        # œil = capsule verticale ; largeur du corps = largeur des caps (2r+1)
        r = self.br
        if fb is None:
            fb = self.fb
        if h < 2 * r:                       # œil presque fermé -> capsule aplatie
            fb.ellipse(cx, cy, r, max(1, h // 2), color, True)
            return
        w = 2 * r + 1
        fb.fill_rect(cx - r, cy - h // 2 + r, w, h - 2 * r, color)
        fb.ellipse(cx, cy - h // 2 + r, r, r, color, True)
        fb.ellipse(cx, cy + h // 2 - r, r, r, color, True)

    # ------------------------------------------------------------- affichage
    def _write_center(self, text, y, rgb, font):
        if font is None or not hasattr(self.tft, "write"):
            return
        text = self._ascii(text)
        try:
            w = self.tft.write_width(font, text)
        except Exception:
            w = len(text) * 10
        x = max(2, self.cfg.SCREEN // 2 - w // 2)
        try:
            self.tft.write(font, text, x, max(0, y - font.HEIGHT // 2), rgb)
        except Exception:
            pass

    def _render_home_static(self):
        """Dessine la partie immobile de l'accueil une seule fois."""
        fb, lc, R = self.fb, self.lc, self.R
        fb.ellipse(lc, lc, R, R, self._base_fb, True)
        fb.ellipse(lc, lc, R - 1, R - 1, self._rim_fb, False)
        fb.ellipse(lc, lc, R - 3, R - 3, self._rim2_fb, False)
        fb.ellipse(lc, 10, 3, 3,
                   _fbc(50,235,150) if self.connected else _fbc(110,115,135), True)
        self.tft.blit_buffer(self.buf, self.ox, self.oy, self.D, self.D)
        # Horloge + prochain rappel, sous les yeux (hors zone de l'animation).
        if getattr(self.cfg, "IDLE_CLOCK", False) and self._hhmm:
            self._write_center(self._hhmm, 208, lcd.color565(160, 175, 205), Inter24)
            if self._agenda and self._agenda.get("label"):
                lab = self._agenda["label"]
                if self._agenda.get("time"):
                    lab = self._agenda["time"] + "  " + lab
                self._write_center(lab, 227, lcd.color565(95, 105, 130), Inter16)
        self._home_static_dirty = False

    def render(self):
        if self.standby:                 # écran éteint : on ne dessine rien
            return
        fb = self.fb
        lc = self.lc
        R = self.R

        if self.screen != "home":
            if not self._ui_dirty:
                return
            self._render_ui()
            self.tft.blit_buffer(self.buf, self.ox, self.oy, self.D, self.D)
            self._draw_ui_assets()
            self._draw_ui_texts()
            self._ui_dirty = False
            self._last_render_screen = self.screen
            return

        if self._last_render_screen != "home":
            self._home_static_dirty = True
        if self._home_static_dirty:
            self._render_home_static()

        t = time.ticks_ms() / 1000.0
        afb = self.anim_fb
        ac = self.ac
        afb.fill(self._base_fb)

        # blob aurora : balancement + parallaxe du regard (inclinaison)
        dx = int(3 * math.sin(t * 0.9) + self.look_x * 0.35)
        dy = int(2 * math.sin(t * 0.6) + self.look_y * 0.35)
        afb.blit(self.afb, ac - self.AW // 2 + dx, ac - self.AH // 2 + dy)

        # deux barres d'état
        h1, h2 = self._bar_heights()
        off = self.gap // 2 + self.br
        ex = int(self.look_x)
        ey = int(self.look_y)
        self._vbar(ac - off + ex, ac + ey, h1, self._bars_fb, afb)
        self._vbar(ac + off + ex, ac + ey, h2, self._bars_fb, afb)

        self.tft.blit_buffer(self.anim_buf, self.aox, self.aoy, self.AD, self.AD)
        self._last_render_screen = "home"
