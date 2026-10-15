"""Affichage Lumen: Waveshare e-paper V4, SSD1306 ou mode sans écran."""
import time

try:
    import ssd1306
except ImportError:
    ssd1306 = None


class UI:
    # Ce sur quoi agit la molette. La police intégrée est ASCII seule: pas
    # d'accent, donc pas de « MODÈLE ».
    WHEEL_LABELS = {
        "model": "MODELE",
        "voice": "VOIX",
        "led": "LED",
    }

    # États bruts poussés par l'application -> libellé affiché. Un état inconnu
    # est affiché tel quel plutôt que masqué: mieux vaut un mot inattendu qu'un
    # « Ready » mensonger. Limité à 10 caractères par la ligne d'état.
    STATUS_LABELS = {
        "idle": "Ready",
        "ready": "Ready",
        "listening": "Listening",
        "thinking": "Thinking",
        "speaking": "Speaking",
        "loading": "Loading",
    }

    def __init__(self, cfg):
        self.cfg = cfg
        self.display = None
        self.kind = getattr(cfg, "DISPLAY_TYPE", "ssd1306")
        self._signature = None
        self._last_refresh = 0
        self._partial_count = 0
        self._errors = 0
        # Sommeil profond de la DALLE (pas du contrôleur). Waveshare
        # déconseille de la laisser alimentée en permanence.
        self._asleep = False
        self._force_full = False
        self._y0 = 0
        self._fb = None
        self._buffer = None
        if self.kind == "epaper_2in13_v4":
            try:
                import framebuf
                from epd2in13_v4 import EPD
                self.display = EPD(cfg)
                self.display.init()
                # Le démo officiel efface toujours la dalle avant la première
                # image; sans cela certains modules V4 n'affichent rien.
                self.display.clear()
                # Format paysage exact du pilote officiel Waveshare Pico:
                # 250x128 MONO_VLSB, dont 122 lignes sont visibles.
                self._buffer = bytearray(250 * 16)
                self._fb = framebuf.FrameBuffer(
                    self._buffer, 250, 128, framebuf.MONO_VLSB
                )
                # Lignes du framebuffer qui n'existent pas sur la dalle:
                # 16*8 - 122 = 6. Elles sont rognées en HAUT de l'écran, d'où
                # le décalage appliqué à tout le dessin. Surchargeable par
                # EPD_Y_OFFSET pour ajuster finement selon la dalle.
                # Les 6 lignes inexistantes sont rognées en HAUT en
                # orientation normale, et en BAS une fois l'image retournée:
                # le décalage du dessin s'inverse donc avec la rotation.
                marge = EPD.ROW_BYTES * 8 - EPD.WIDTH
                defaut = 0 if getattr(cfg, "EPD_ROTATION", 0) == 180 else marge
                self._y0 = getattr(cfg, "EPD_Y_OFFSET", defaut)
            except Exception as exc:
                self.display = None
                print("e-paper disabled:", exc)
        elif self.kind == "ssd1306" and ssd1306:
            try:
                from machine import I2C, Pin
                i2c = I2C(cfg.I2C_ID, scl=Pin(cfg.I2C_SCL), sda=Pin(cfg.I2C_SDA))
                self.display = ssd1306.SSD1306_I2C(cfg.DISPLAY_WIDTH, cfg.DISPLAY_HEIGHT, i2c, addr=cfg.DISPLAY_ADDRESS)
            except Exception as exc:
                print("Display disabled:", exc)

    def render(self, state):
        if not self.display:
            return
        if self.kind == "epaper_2in13_v4":
            self._render_epaper(state)
            return
        d = self.display
        d.fill(0)
        d.text("LUMEN", 0, 0)
        d.text(("WiFi " if state.connected else "OFF ") + state.ip[-12:], 0, 10)
        d.text("Backend: " + state.backend[:12], 0, 22)
        d.text("Model: " + state.model[:14], 0, 34)
        d.text("Vol %3d  %s" % (state.volume, str(state.chat_mode).upper()[:7]), 0, 46)
        d.text("%s  ENC %s" % (state.mode[:10], str(state.encoder_fn)[:5]), 0, 56)
        d.show()

    def _render_epaper(self, state):
        signature = (
            state.connected, state.ip, state.backend, state.model,
            state.volume, state.desktop, state.paused, state.mode,
            state.chat_mode, state.encoder_fn, state.voice, state.led_color,
            state.tps, state.ctx_used, state.ctx_total,
        )
        now = time.ticks_ms()
        if signature == self._signature:
            self._maybe_sleep(now)
            return
        minimum = getattr(self.cfg, "EPD_MIN_REFRESH_MS", 700)
        if self._signature is not None and time.ticks_diff(now, self._last_refresh) < minimum:
            return

        # Réveil de la dalle si elle dormait. Le sommeil profond perd le
        # contenu des deux RAM: le prochain rafraîchissement doit donc être
        # COMPLET, sinon le partiel comparerait à une RAM indéfinie.
        if self._asleep:
            try:
                self.display.init()
            except Exception as exc:
                print("e-paper: reveil impossible:", exc)
                return
            self._asleep = False
            self._force_full = True

        f = self._fb
        f.fill(1)

        # Décalage vertical de tout le dessin.
        #
        # Le framebuffer paysage fait 128 lignes (16 octets) alors que la dalle
        # n'en compte que 122: 6 lignes n'existent pas physiquement. Le pilote
        # inverse l'ordre des bandes, si bien que la ligne y=0 tombe sur le
        # pixel 127 de la dalle, hors zone visible. Sans ce décalage, les 6
        # premières lignes sont donc rognées en haut de l'écran, et 6 lignes
        # vides apparaissent en bas: le dessin semble remonté.
        dy = self._y0

        # Cadre fin inspiré de la fenêtre encastrée du mockup.
        f.rect(1, 1 + dy, 248, 120, 0)
        f.rect(3, 3 + dy, 244, 116, 0)

        # Icône Lumen: carré noir arrondi, anneau blanc, deux barres blanches.
        # Le disque blanc puis le disque noir plus petit creusent l'anneau; il
        # n'existe pas de primitive d'arc dans framebuf.
        self._fill_round_rect(f, 7, 8 + dy, 42, 42, 9, 0)
        self._fill_circle(f, 28, 29 + dy, 17, 1)
        self._fill_circle(f, 28, 29 + dy, 14, 0)
        f.fill_rect(22, 24 + dy, 3, 11, 1)
        f.fill_rect(31, 24 + dy, 3, 11, 1)

        # Titre principal, étiquette de la molette et badge backend.
        self._scaled_text(f, "Lumen", 57, 10 + dy, 2, 0)
        # Cette rangée est coincée entre l'icône et le badge backend: on y met
        # l'étiquette, qui est courte et de longueur fixe. La VALEUR va sur la
        # rangée du dessous, qui court sur toute la largeur.
        #
        # Un petit cadran dessiné dit « c'est la molette qui agit là-dessus »
        # bien mieux que l'abréviation « ENC », qui ne parlait qu'à celui qui
        # avait écrit le firmware.
        self._dial_icon(f, 61, 41 + dy)
        f.text(self.WHEEL_LABELS.get(state.encoder_fn, str(state.encoder_fn).upper()),
               74, 37 + dy, 0)
        backend = str(state.backend or "--")[:8]
        badge_w = len(backend) * 8 + 8
        badge_x = 238 - badge_w
        self._pill(f, badge_x, 33 + dy, badge_w, 15, 0)
        f.text(backend, badge_x + 4, 37 + dy, 1)

        # Haut à droite: réseau, puis le débit de la dernière réponse. Le
        # symbole de batterie a été retiré, le contrôleur étant alimenté en USB.
        self._wifi_icon(f, 150, 10 + dy, state.ip != "0.0.0.0")
        if state.tps > 0:
            speed = "%.1f t/s" % state.tps if state.tps < 100 else "%d t/s" % state.tps
            f.text(speed, 238 - len(speed) * 8, 10 + dy, 0)

        # Etat principal. La formulation reprend le point noir + Ready.
        if state.paused:
            status = "Paused"
        elif not state.connected and state.ip != "0.0.0.0":
            # Tant que Lumen n'est pas relié, l'information utile n'est pas
            # « Ready » mais l'adresse à saisir dans Réglages. Elle disparaît
            # d'elle-même dès que l'application se connecte.
            status = state.ip
        else:
            status = self.STATUS_LABELS.get(
                str(state.mode or "idle").lower(), str(state.mode)
            )
        # Rangée pleine largeur: la valeur pilotée par la molette. Elle passe
        # sous l'icône, ce qui laisse près du double de place par rapport à la
        # rangée précédente — assez pour lire le nombre de paramètres d'un
        # modèle au nom long, qui était systématiquement coupé.
        voice = self._voice_short(state.voice)
        voice_w = (len(voice) * 8 + 8) if voice else 0
        if voice:
            self._pill(f, 238 - voice_w, 52 + dy, voice_w, 13, 0)
            f.text(voice, 238 - voice_w + 4, 54 + dy, 1)
        limit = max(1, (238 - voice_w - 6 - 11) // 8)
        f.text(self._encoder_value(state, limit), 11, 54 + dy, 0)

        # Mode de discussion en pastille, empilée sous celle de la voix. La
        # ligne d'état à gauche fait au plus 15 caractères (une adresse IP),
        # soit x=27..147: aucun recouvrement avec la pastille.
        # y=68 plutôt que 65: cela porte l'écart avec la pastille de voix de
        # 1 à 4 px, et centre la pastille (73,5) sur le point de la ligne
        # d'état (73), à côté duquel elle se trouve.
        chat = str(state.chat_mode or "chat").upper()[:7]
        chat_w = len(chat) * 8 + 8
        self._pill(f, 238 - chat_w, 68 + dy, chat_w, 13, 0)
        f.text(chat, 238 - chat_w + 4, 70 + dy, 1)

        self._fill_circle(f, 15, 73 + dy, 4, 0)
        # Le texte fait 8 px de haut: pour que son milieu tombe sur celui de la
        # pastille (y=73), il commence à 69 et non 65 — sinon il paraît remonté.
        # 15 caractères: "255.255.255.255" tient à partir de x=27 (8 px par
        # caractère, soit 147 px, bien avant la bordure droite à x=241).
        self._scaled_text(f, status[:15], 27, 69 + dy, 1, 0)

        # Bandeau secondaire discret : volume, mode et liaison Lumen.
        f.hline(9, 91 + dy, 232, 0)
        # Bandeau resserré pour loger l'occupation du contexte à droite: la
        # jauge passe de 72 à 40 px, ce qui reste parfaitement lisible.
        f.text("VOL", 11, 99 + dy, 0)
        f.rect(38, 100 + dy, 40, 7, 0)
        f.fill_rect(40, 102 + dy, min(36, state.volume * 36 // 100), 3, 0)
        f.text("%d%%" % state.volume, 82, 99 + dy, 0)
        if state.ctx_total > 0:
            ctx = "CTX %s/%s" % (self._short_tokens(state.ctx_used),
                                 self._short_tokens(state.ctx_total))
            f.text(ctx, 222 - len(ctx) * 8, 99 + dy, 0)
        if state.connected:
            self._fill_circle(f, 232, 103 + dy, 3, 0)
        else:
            self._circle(f, 232, 103 + dy, 3, 0)

        full_every = max(1, getattr(self.cfg, "EPD_FULL_REFRESH_EVERY", 20))
        try:
            # Le rafraîchissement complet fait clignoter la dalle. En tournant
            # la molette, le seuil était atteint en quelques secondes et
            # l'écran semblait redémarrer. On le diffère tant que les
            # changements s'enchaînent, avec un plafond pour que le
            # dédoublement des rafraîchissements partiels finisse par être
            # nettoyé.
            rapide = time.ticks_diff(now, self._last_refresh) < 2000
            plein = (self._signature is None
                     or self._force_full
                     or self._partial_count >= full_every * 3
                     or (self._partial_count >= full_every and not rapide))
            if plein:
                # display_base() écrit l'image dans les DEUX RAM (0x24 et
                # 0x26). C'est indispensable: un rafraîchissement partiel
                # compare la nouvelle image à la RAM 0x26. Avec display_full(),
                # qui n'écrit que 0x24, tous les partiels suivants comparaient
                # à une RAM jamais initialisée et n'affichaient donc rien.
                self.display.display_base(self._buffer)
                self._partial_count = 0
                self._force_full = False
            else:
                self.display.display_partial(self._buffer)
                self._partial_count += 1
        except Exception as exc:
            # L'interface réseau et les commandes restent utilisables même si
            # l'écran est débranché ou si BUSY ne revient jamais au repos.
            # On réessaie plus tard avec une ré-initialisation complète plutôt
            # que de condamner l'écran pour toute la session.
            print("e-paper refresh failed:", exc)
            self._errors += 1
            self._last_refresh = time.ticks_ms()
            self._signature = None
            self._partial_count = 0
            if self._errors >= 5:
                print("e-paper disabled after 5 failures")
                self.display = None
                return
            try:
                self.display.init()
            except Exception as exc2:
                print("e-paper re-init failed:", exc2)
            return
        self._errors = 0
        self._signature = signature
        self._last_refresh = time.ticks_ms()

    def _maybe_sleep(self, now):
        """Endort la DALLE après une période sans changement.

        Waveshare est explicite : « ne laissez pas l'e-Paper sous tension
        longtemps, mettez-le en veille quand vous ne le rafraîchissez pas,
        sinon il reste sous haute tension, ce qui l'endommage de façon
        irréversible. » C'est le seul point qui joue vraiment sur la durée de
        vie ; l'image, elle, tient sans alimentation.

        On n'efface RIEN : le contenu reste lisible, et l'effacer coûterait un
        rafraîchissement de plus alors que c'est leur nombre qui use la dalle.
        """
        if self._asleep or self._signature is None:
            return
        delay = getattr(self.cfg, "EPD_SLEEP_AFTER_MS", 60_000)
        if delay <= 0 or time.ticks_diff(now, self._last_refresh) < delay:
            return
        try:
            self.display.sleep()
            self._asleep = True
        except Exception as exc:
            print("e-paper: mise en veille impossible:", exc)

    @classmethod
    def _dial_icon(cls, fb, cx, cy):
        """Petit cadran cranté, avec son repère vers le haut."""
        cls._circle(fb, cx, cy, 5, 0)
        fb.vline(cx, cy - 4, 3, 0)

    @staticmethod
    def _short_tokens(n):
        """Nombre de jetons en forme compacte: 820, 2.4k, 8k, 128k.

        Division par 1024, pas par 1000: une fenêtre de contexte est toujours
        une puissance de deux, et 8192 doit se lire « 8k » et non « 8.2k ».
        Au-delà de 10k la décimale n'apprend plus rien et coûte deux caractères
        sur une ligne qui en compte treize au maximum. Arithmétique entière:
        MicroPython n'arrondit pas toujours les flottants comme on l'attend.
        """
        n = int(n)
        if n < 1024:
            return str(n)
        tenths = (n * 10 + 512) // 1024          # dixièmes de k, arrondis
        if tenths >= 100:
            return "%dk" % ((n + 512) // 1024)
        if tenths % 10 == 0:
            return "%dk" % (tenths // 10)
        return "%d.%dk" % (tenths // 10, tenths % 10)

    @staticmethod
    def _voice_short(voice):
        """"fr_FR-siwis-medium" -> "siwis": le nom de la voix, sans le préfixe
        de langue commun à toutes ni le suffixe de qualité."""
        name = str(voice or "").strip()
        if not name:
            return ""
        parts = name.split("-")
        if len(parts) >= 2:
            name = parts[1]
        return name[:7]

    @classmethod
    def _fill_round_rect(cls, fb, x, y, w, h, r, color):
        fb.fill_rect(x + r, y, w - 2 * r, h, color)
        fb.fill_rect(x, y + r, r, h - 2 * r, color)
        fb.fill_rect(x + w - r, y + r, r, h - 2 * r, color)
        for cx, cy in ((x + r, y + r), (x + w - r - 1, y + r),
                       (x + r, y + h - r - 1), (x + w - r - 1, y + h - r - 1)):
            cls._fill_circle(fb, cx, cy, r, color)

    @staticmethod
    def _shorten(text, limit):
        """Tronque par le MILIEU, pour garder les deux extrémités.

        Un nom de GGUF porte le nombre de paramètres au début
        («LFM2.5-1.2B-…») et la quantification à la fin («…-Q4_K_M»). Couper
        la fin fait donc perdre l'une ou l'autre selon la longueur; élider le
        milieu conserve les deux, qui sont précisément ce qu'on cherche à lire.
        """
        if len(text) <= limit:
            return text
        if limit < 10:
            return text[:limit]
        tail = min(6, (limit - 2) // 2)
        return text[:limit - 2 - tail] + ".." + text[-tail:]

    @classmethod
    def _encoder_value(cls, state, limit=12):
        """Valeur courante de la fonction sélectionnée sur la molette."""
        if state.encoder_fn == "led":
            return cls._shorten(str(state.led_color or "--"), limit)
        if state.encoder_fn == "voice":
            voice = str(state.voice or "--")
            # "fr_FR-siwis-medium" -> "siwis-medium": le préfixe de langue est
            # le même pour toutes les voix et gaspille la moitié de la place.
            if "-" in voice:
                voice = voice.split("-", 1)[1]
            return cls._shorten(voice, limit)
        # On retire les suffixes purement techniques avant de tronquer, sinon
        # un GGUF n'affiche que son préfixe et semble désynchronisé de l'app.
        model = str(state.model or "--").replace(":latest", "")
        if model.endswith(".gguf"):
            model = model[:-5]
        return cls._shorten(model, limit)

    @staticmethod
    def _circle(fb, cx, cy, radius, color):
        x, y, err = radius, 0, 1 - radius
        while x >= y:
            for px, py in (
                (cx + x, cy + y), (cx + y, cy + x),
                (cx - y, cy + x), (cx - x, cy + y),
                (cx - x, cy - y), (cx - y, cy - x),
                (cx + y, cy - x), (cx + x, cy - y),
            ):
                fb.pixel(px, py, color)
            y += 1
            if err < 0:
                err += 2 * y + 1
            else:
                x -= 1
                err += 2 * (y - x + 1)

    @staticmethod
    def _fill_circle(fb, cx, cy, radius, color):
        for y in range(-radius, radius + 1):
            half = int((radius * radius - y * y) ** 0.5)
            fb.hline(cx - half, cy + y, half * 2 + 1, color)

    @classmethod
    def _pill(cls, fb, x, y, width, height, color):
        """Pastille arrondie. La HAUTEUR DOIT ÊTRE IMPAIRE.

        _fill_circle couvre 2r+1 lignes. Avec r = hauteur/2, les bouchons
        débordaient d'une ligne SOUS le rectangle: les angles paraissaient
        décalés vers le bas. Avec r = (hauteur-1)/2 et une hauteur impaire,
        cercle et rectangle coïncident exactement.
        """
        radius = (height - 1) // 2
        cy = y + radius
        fb.fill_rect(x + radius, y, max(0, width - 2 * radius), height, color)
        cls._fill_circle(fb, x + radius, cy, radius, color)
        cls._fill_circle(fb, x + width - radius - 1, cy, radius, color)

    _scratch = None

    @classmethod
    def _scaled_text(cls, fb, text, x, y, scale, color):
        if scale <= 1:
            fb.text(text, x, y, color)
            return
        import framebuf
        width = max(8, len(text) * 8)
        # Tampon réutilisé: ce chemin est emprunté à chaque rendu, et allouer
        # à chaque fois contribuait à fragmenter le tas.
        need = (width // 8) * 8
        if cls._scratch is None or len(cls._scratch) < need:
            cls._scratch = bytearray(need)
        scratch = cls._scratch
        glyphs = framebuf.FrameBuffer(scratch, width, 8, framebuf.MONO_HLSB)
        glyphs.fill(0)
        glyphs.text(text, 0, 0, 1)
        for gy in range(8):
            for gx in range(width):
                if glyphs.pixel(gx, gy):
                    fb.fill_rect(x + gx * scale, y + gy * scale, scale, scale, color)

    @staticmethod
    def _wifi_icon(fb, x, y, active):
        color = 0
        # Trois chevrons donnent une lecture nette à cette résolution.
        fb.line(x, y + 3, x + 6, y, color)
        fb.line(x + 6, y, x + 12, y + 3, color)
        fb.line(x + 3, y + 6, x + 6, y + 4, color)
        fb.line(x + 6, y + 4, x + 9, y + 6, color)
        if active:
            fb.fill_rect(x + 5, y + 8, 3, 3, color)
        else:
            fb.pixel(x + 6, y + 9, color)

