// Catalogue des composants domotiques pris en charge. Source de vérité partagée
// entre l'UI de contrôle (rendu des widgets, lecture d'état) et le générateur de
// firmware MicroPython (fragments de code par type). Chaque type décrit :
//   - meta : libellé, icône, couleur, familles de cartes compatibles
//   - kind : "sensor" (lecture) | "actuator" (commande)
//   - pins : broche(s) GPIO par défaut + indice
//   - fw   : fragments MicroPython { imports, setup, read, cmd }
//     read = corps d'une fonction renvoyant un dict d'état (capteurs)
//     cmd  = corps d'une fonction (action, params) qui agit sur l'objet
//
// Les protocoles ouverts visés : Wi-Fi/IP + HTTP (REST) pour le contrôle, UDP
// broadcast pour la découverte. La signature HMAC porte la sécurité.

export const BOARDS = [
  { id: "esp32", label: "ESP32 (DevKit)" },
  { id: "esp32s3", label: "ESP32-S3 Matrix 8x8" },
  { id: "pico", label: "Raspberry Pi Pico W" },
];

// Icônes (contenu interne d'un <svg viewBox="0 0 24 24">).
const I = {
  temp: '<path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0z"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>',
  relay: '<rect x="3" y="9" width="18" height="6" rx="2"/><path d="M7 9V7a5 5 0 0 1 10 0v2"/>',
  rgb: '<rect x="3" y="10" width="18" height="5" rx="2.5"/><circle cx="7" cy="12.5" r="1"/><circle cx="12" cy="12.5" r="1"/><circle cx="17" cy="12.5" r="1"/>',
  matrix: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 4v16M12 4v16M16 4v16M4 8h16M4 12h16M4 16h16"/>',
  dimmer: '<circle cx="12" cy="12" r="8"/><path d="M12 12l4-2"/>',
  presence: '<circle cx="12" cy="7" r="3"/><path d="M6 21v-2a6 6 0 0 1 12 0v2"/>',
  servo: '<rect x="6" y="9" width="12" height="9" rx="1.5"/><path d="M12 9V4M12 4l-2 2M12 4l2 2"/>',
  contact: '<rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5"/>',
  air: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
  dust: '<circle cx="6" cy="7" r="1.5"/><circle cx="13" cy="5" r="1"/><circle cx="18" cy="9" r="1.5"/><circle cx="9" cy="13" r="1"/><circle cx="16" cy="15" r="1.5"/><circle cx="7" cy="19" r="1.5"/><circle cx="13" cy="20" r="1"/>',
  water: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  doorbell: '<rect x="7" y="2" width="10" height="20" rx="3"/><circle cx="12" cy="8" r="2"/><circle cx="12" cy="16" r="2.5"/>',
  thermostat: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/><path d="M8 17h8"/>',
};

export const CATALOG = {
  temperature: {
    label: "Capteur température / humidité (DHT22)",
    icon: I.temp, color: "#ff9f0a", kind: "sensor",
    boards: ["esp32", "esp32s3", "pico"], pins: "4", pinHint: "Broche data du DHT22/DHT11 (ex. 4).",
    fw: {
      imports: "import dht",
      setup: "_dht = dht.DHT22(machine.Pin({PIN0}))",
      read: "    _dht.measure()\n    return {'temp': round(_dht.temperature(), 1), 'hum': round(_dht.humidity(), 1)}",
      cmd: "    return {'ok': False, 'err': 'capteur en lecture seule'}",
    },
  },
  light_sensor: {
    label: "Capteur de luminosité (LDR / photorésistance)",
    icon: I.light, color: "#ffd60a", kind: "sensor",
    boards: ["esp32", "esp32s3", "pico"], pins: "34", pinHint: "Broche ADC reliée au pont LDR (ESP32: 32-39, ESP32-S3: GPIO ADC disponible sur la carte, Pico: 26-28).",
    fw: {
      imports: "",
      setup: "_ldr = machine.ADC(machine.Pin({PIN0}))\ntry:\n    _ldr.atten(machine.ADC.ATTN_11DB)\nexcept AttributeError:\n    pass",
      read: "    raw = _ldr.read_u16() if hasattr(_ldr, 'read_u16') else _ldr.read()\n    return {'level': round(raw / 65535 * 100 if raw > 4095 else raw / 4095 * 100)}",
      cmd: "    return {'ok': False, 'err': 'capteur en lecture seule'}",
    },
  },
  relay: {
    label: "Relais / actionneur (on-off)",
    icon: I.relay, color: "#0a84ff", kind: "actuator",
    boards: ["esp32", "esp32s3", "pico"], pins: "26", pinHint: "Broche de commande du module relais (ex. 26).",
    fw: {
      imports: "",
      setup: "_relay = machine.Pin({PIN0}, machine.Pin.OUT)\n_state = {'on': False}",
      read: "    return {'on': _state['on']}",
      cmd: "    if action == 'set':\n        _state['on'] = bool(params.get('on'))\n        _relay.value(1 if _state['on'] else 0)\n    elif action == 'toggle':\n        _state['on'] = not _state['on']\n        _relay.value(1 if _state['on'] else 0)\n    return {'ok': True, 'on': _state['on']}",
    },
  },
  rgb: {
    label: "Bandeau / LED RGB (NeoPixel WS2812)",
    icon: I.rgb, color: "#bf5af2", kind: "actuator",
    boards: ["esp32", "esp32s3", "pico"], pins: "5, 8", pinHint: "Broche data, puis nombre de LED (ex. « 5, 3 » = broche 5, 3 LEDs).",
    extra: { count: 8 },
    fw: {
      imports: "import neopixel",
      setup: "_np = neopixel.NeoPixel(machine.Pin({PIN0}), {COUNT})\n_state = {'on': False, 'r': 255, 'g': 255, 'b': 255, 'brightness': 100}\n\ndef _apply():\n    f = (_state['brightness'] / 100.0) if _state['on'] else 0.0\n    col = (int(_state['r']*f), int(_state['g']*f), int(_state['b']*f))\n    for i in range(len(_np)):\n        _np[i] = col\n    _np.write()",
      read: "    return dict(_state)",
      cmd: "    if action == 'set':\n        for k in ('r', 'g', 'b', 'brightness'):\n            if k in params: _state[k] = int(params[k])\n        if 'on' in params: _state['on'] = bool(params['on'])\n        _apply()\n    elif action == 'toggle':\n        _state['on'] = not _state['on']; _apply()\n    _r = dict(_state); _r['ok'] = True\n    return _r",
    },
  },
  matrix8: {
    label: "Matrice LED 8x8 (ESP32-S3 / NeoPixel)",
    icon: I.matrix, color: "#32ade6", kind: "actuator",
    boards: ["esp32s3", "esp32", "pico"], pins: "14, 64", pinHint: "Broche data de la matrice, puis 64 LEDs. Modifiez la broche selon votre carte.",
    extra: { count: 64 },
    fw: {
      imports: "import neopixel",
      setup: `_np = neopixel.NeoPixel(machine.Pin({PIN0}), {COUNT})
_state = {'on': False, 'r': 64, 'g': 180, 'b': 255, 'brightness': 35, 'pattern': 'idle'}
_custom = []
_PATTERNS = {
    'idle':  ['........', '..#..#..', '..#..#..', '........', '........', '..####..', '........', '........'],
    'happy': ['........', '..#..#..', '..#..#..', '........', '.#....#.', '..####..', '........', '........'],
    'think': ['........', '..#..#..', '........', '...##...', '..#..#..', '....#...', '..#.....', '........'],
    'alert': ['...##...', '...##...', '...##...', '...##...', '...##...', '........', '...##...', '...##...'],
    'ok':    ['#.....#.', '.#...#..', '..#.#...', '...#....', '..#.#...', '.#...#..', '#.....#.', '........'],
    'heart': ['.##..##.', '########', '########', '.######.', '..####..', '...##...', '........', '........'],
}

# Mapping pixel -> index dans la chaine. Par defaut LINEAIRE (ligne par ligne,
# gauche->droite) : ce panneau gere deja l'ordre cote materiel, donc on n'inverse
# rien ici. Si un jour tu branches une matrice serpentin "brute" qui affiche les
# lignes 2,4,6,8 en miroir, passe _SERPENTINE a True.
_SERPENTINE = False

def _xy(x, y):
    if _SERPENTINE and y % 2 == 1:
        x = 7 - x
    return y * 8 + x

def _clear():
    for i in range(len(_np)):
        _np[i] = (0, 0, 0)

def _color():
    f = (_state['brightness'] / 100.0) if _state['on'] else 0.0
    # Matrice ESP32-S3 courante en ordre GRB : rouge et vert inversés si on
    # envoie du RGB pur. On garde l'API Lumen en RGB et on adapte ici.
    return (int(_state['g'] * f), int(_state['r'] * f), int(_state['b'] * f))

def _pixel_color(raw):
    if not raw:
        return (0, 0, 0)
    if isinstance(raw, str):
        s = raw
        if len(s) >= 7 and s[0] == '#':
            r = int(s[1:3], 16)
            g = int(s[3:5], 16)
            b = int(s[5:7], 16)
        else:
            return (0, 0, 0)
    else:
        try:
            r = int(raw[0]); g = int(raw[1]); b = int(raw[2])
        except Exception:
            return (0, 0, 0)
    f = _state['brightness'] / 100.0
    return (int(g * f), int(r * f), int(b * f))

def _draw(name=None):
    if name is not None:
        _state['pattern'] = name if name in _PATTERNS else 'idle'
    _clear()
    if _state['on']:
        pat = _PATTERNS.get(_state['pattern'], _PATTERNS['idle'])
        col = _color()
        for y, row in enumerate(pat):
            for x, ch in enumerate(row[:8]):
                if ch != '.':
                    idx = _xy(x, y)
                    if idx < len(_np):
                        _np[idx] = col
    _np.write()

def _draw_pixels(pixels, remember=True):
    global _custom
    if remember:
        _custom = list(pixels)
    _clear()
    _state['on'] = True
    _state['pattern'] = 'custom'
    for i, raw in enumerate(pixels[:len(_np)]):
        x = i % 8
        y = i // 8
        idx = _xy(x, y)
        if idx < len(_np):
            _np[idx] = _pixel_color(raw)
    _np.write()

_draw('idle')`,
      read: "    return dict(_state)",
      cmd: "    if action == 'set':\n        for k in ('r', 'g', 'b', 'brightness'):\n            if k in params: _state[k] = int(params[k])\n        if 'on' in params: _state['on'] = bool(params['on'])\n        if 'pattern' in params: _state['pattern'] = str(params['pattern'])\n        if _state.get('pattern') == 'custom' and _custom:\n            _draw_pixels(_custom, False)\n        else:\n            _draw()\n    elif action == 'toggle':\n        _state['on'] = not _state['on']\n        if _state.get('pattern') == 'custom' and _custom:\n            _draw_pixels(_custom, False)\n        else:\n            _draw()\n    elif action == 'clear':\n        _state['on'] = False; _draw()\n    elif action in ('draw', 'custom'):\n        _draw_pixels(params.get('pixels') or [])\n    elif action in ('status', 'face'):\n        _state['on'] = True\n        _draw(str(params.get('status') or params.get('face') or params.get('pattern') or 'idle'))\n    _r = dict(_state); _r['ok'] = True\n    return _r",
    },
  },
  dimmer: {
    label: "Lumière variable (LED PWM)",
    icon: I.dimmer, color: "#ff9f0a", kind: "actuator",
    boards: ["esp32", "esp32s3", "pico"], pins: "2", pinHint: "Broche PWM pilotant la LED/MOSFET (ex. 2).",
    fw: {
      imports: "",
      setup: "_pwm = machine.PWM(machine.Pin({PIN0}))\n_pwm.freq(1000)\n_state = {'on': False, 'brightness': 100}\n\ndef _apply():\n    duty = int((_state['brightness'] / 100.0) * 65535) if _state['on'] else 0\n    try:\n        _pwm.duty_u16(duty)\n    except AttributeError:\n        _pwm.duty(int(duty / 65535 * 1023))",
      read: "    return dict(_state)",
      cmd: "    if action == 'set':\n        if 'brightness' in params: _state['brightness'] = int(params['brightness'])\n        if 'on' in params: _state['on'] = bool(params['on'])\n        _apply()\n    elif action == 'toggle':\n        _state['on'] = not _state['on']; _apply()\n    _r = dict(_state); _r['ok'] = True\n    return _r",
    },
  },
  presence: {
    label: "Détecteur de présence (PIR)",
    icon: I.presence, color: "#30d1c8", kind: "sensor",
    boards: ["esp32", "esp32s3", "pico"], pins: "27", pinHint: "Broche OUT du capteur PIR (ex. 27).",
    fw: {
      imports: "",
      setup: "_pir = machine.Pin({PIN0}, machine.Pin.IN)",
      read: "    return {'motion': bool(_pir.value())}",
      cmd: "    return {'ok': False, 'err': 'capteur en lecture seule'}",
    },
  },
  contact: {
    label: "Contact d'ouverture (porte/fenêtre, ILS)",
    icon: I.contact, color: "#5e5ce6", kind: "sensor",
    boards: ["esp32", "esp32s3", "pico"], pins: "14", pinHint: "Broche du contact ILS, pull-up interne activé (ex. 14).",
    fw: {
      imports: "",
      setup: "_reed = machine.Pin({PIN0}, machine.Pin.IN, machine.Pin.PULL_UP)",
      read: "    return {'open': bool(_reed.value())}",
      cmd: "    return {'ok': False, 'err': 'capteur en lecture seule'}",
    },
  },
  servo: {
    label: "Servomoteur (volet, serrure, vanne)",
    icon: I.servo, color: "#ff6482", kind: "actuator",
    boards: ["esp32", "esp32s3", "pico"], pins: "13", pinHint: "Broche PWM du servo (ex. 13).",
    fw: {
      imports: "",
      setup: "_servo = machine.PWM(machine.Pin({PIN0}))\n_servo.freq(50)\n_state = {'angle': 90}\n\ndef _apply():\n    us = 500 + (_state['angle'] / 180.0) * 2000\n    duty = int(us / 20000 * 65535)\n    try:\n        _servo.duty_u16(duty)\n    except AttributeError:\n        _servo.duty(int(duty / 65535 * 1023))",
      read: "    return dict(_state)",
      cmd: "    if action == 'set' and 'angle' in params:\n        _state['angle'] = max(0, min(180, int(params['angle'])))\n        _apply()\n    _r = dict(_state); _r['ok'] = True\n    return _r",
    },
  },

  // ---- Qualité de l'air ----
  co2: {
    label: "Qualité de l'air : CO₂ (Sensirion SCD40/41, I²C)",
    icon: I.air, color: "#34c759", kind: "sensor",
    boards: ["esp32", "esp32s3", "pico"], pins: "21, 22", pinHint: "SDA puis SCL (ESP32 : 21, 22 ; Pico W : 4, 5). Le SCD4x donne aussi température et humidité.",
    fw: {
      imports: "",
      setup: "_i2c = machine.I2C(0, sda=machine.Pin({PIN0}), scl=machine.Pin({PIN1}), freq=100000)\n_last = {}\ntry:\n    _i2c.writeto(0x62, b'\\x21\\xb1')  # start_periodic_measurement\nexcept Exception as e:\n    print('SCD4x:', e)",
      read: "    try:\n        _i2c.writeto(0x62, b'\\xec\\x05')  # read_measurement\n        time.sleep_ms(2)\n        d = _i2c.readfrom(0x62, 9)\n        co2 = (d[0] << 8) | d[1]\n        if co2:\n            _last['co2'] = co2\n            _last['temp'] = round(-45 + 175 * (((d[3] << 8) | d[4]) / 65535), 1)\n            _last['hum'] = round(100 * (((d[6] << 8) | d[7]) / 65535), 1)\n    except Exception:\n        pass\n    if not _last:\n        return {'err': 'mesure en cours (5 s apres le demarrage)'}\n    _r = dict(_last)\n    _r['level'] = 'bon' if _last['co2'] < 800 else ('moyen' if _last['co2'] < 1200 else 'aerer')\n    return _r",
      cmd: "    return {'ok': False, 'err': 'capteur en lecture seule'}",
    },
  },
  particles: {
    label: "Qualité de l'air : particules PM1 / PM2.5 / PM10 (Plantower PMS5003, UART)",
    icon: I.dust, color: "#8e8e93", kind: "sensor",
    boards: ["esp32", "esp32s3", "pico"], pins: "16", pinHint: "Broche RX de la carte reliée au TX du PMS5003 (ESP32 : 16 ; Pico W : 5). Alimentation 5 V.",
    fw: {
      imports: "",
      setup: "try:\n    _uart = machine.UART(1, baudrate=9600, rx=machine.Pin({PIN0}))\nexcept TypeError:\n    _uart = machine.UART(1, baudrate=9600)\n_last = {}",
      read: "    try:\n        buf = _uart.read()\n        if buf:\n            i = buf.rfind(b'BM')\n            if i >= 0 and len(buf) - i >= 32:\n                f = buf[i:i + 32]\n                _last['pm1'] = (f[10] << 8) | f[11]\n                _last['pm25'] = (f[12] << 8) | f[13]\n                _last['pm10'] = (f[14] << 8) | f[15]\n    except Exception:\n        pass\n    if not _last:\n        return {'err': 'en attente du capteur'}\n    _r = dict(_last)\n    _r['level'] = 'bon' if _last['pm25'] <= 15 else ('moyen' if _last['pm25'] <= 35 else 'mauvais')\n    return _r",
      cmd: "    return {'ok': False, 'err': 'capteur en lecture seule'}",
    },
  },
  water_leak: {
    label: "Détecteur de fuite d'eau",
    icon: I.water, color: "#0a84ff", kind: "sensor",
    boards: ["esp32", "esp32s3", "pico"], pins: "33", pinHint: "Sortie numérique (DO) du module, active à l'état bas quand la sonde est mouillée (ex. 33). Pull-up interne activé.",
    fw: {
      imports: "",
      setup: "_leak = machine.Pin({PIN0}, machine.Pin.IN, machine.Pin.PULL_UP)",
      read: "    return {'leak': _leak.value() == 0}",
      cmd: "    return {'ok': False, 'err': 'capteur en lecture seule'}",
    },
  },
  doorbell: {
    label: "Sonnette avec caméra (ESP32-CAM)",
    icon: I.doorbell, color: "#ff9f0a", kind: "sensor",
    boards: ["esp32"], pins: "13", pinHint: "Bouton de sonnette entre cette broche et GND (ESP32-CAM : 13 ou 12). Firmware MicroPython avec module camera requis (build lemariva).",
    fw: {
      imports: "import ubinascii",
      setup: "_btn = machine.Pin({PIN0}, machine.Pin.IN, machine.Pin.PULL_UP)\n_state = {'last_ring': 0, 'camera': False}\ntry:\n    import camera\n    camera.init(0, format=camera.JPEG)\n    try:\n        camera.framesize(camera.FRAME_VGA)\n    except Exception:\n        pass\n    _state['camera'] = True\nexcept Exception as e:\n    print('camera:', e)\n\ndef _on_ring(p):\n    _state['last_ring'] = time.time()\n_btn.irq(trigger=machine.Pin.IRQ_FALLING, handler=_on_ring)",
      read: "    _r = dict(_state)\n    _r['ring'] = bool(_state['last_ring']) and (time.time() - _state['last_ring']) < 15  # sonnee il y a moins de 15 s\n    return _r",
      cmd: "    if action in ('snapshot', 'photo'):\n        if not _state['camera']:\n            return {'ok': False, 'err': 'camera indisponible (firmware camera requis)'}\n        import camera\n        img = camera.capture()\n        return {'ok': True, 'jpeg': ubinascii.b2a_base64(img).decode().strip()}\n    return {'ok': False, 'err': 'action inconnue'}",
    },
  },
  thermostat: {
    label: "Thermostat avec consigne (DHT22 + relais de chauffe)",
    icon: I.thermostat, color: "#ff375f", kind: "actuator",
    boards: ["esp32", "esp32s3", "pico"], pins: "4, 26", pinHint: "Broche data du DHT22, puis broche du relais de chauffage (ex. « 4, 26 »). La régulation tourne sur la carte, même Lumen éteint.",
    fw: {
      imports: "import dht",
      setup: "_dht = dht.DHT22(machine.Pin({PIN0}))\n_heat = machine.Pin({PIN1}, machine.Pin.OUT)\n_state = {'mode': 'heat', 'setpoint': 20.0, 'hyst': 0.5, 'temp': None, 'hum': None, 'heating': False}\n_last = [0]\n\ndef _regulate():\n    t = _state['temp']\n    if _state['mode'] != 'heat' or t is None:\n        _state['heating'] = False\n    elif t < _state['setpoint'] - _state['hyst']:\n        _state['heating'] = True\n    elif t > _state['setpoint'] + _state['hyst']:\n        _state['heating'] = False\n    _heat.value(1 if _state['heating'] else 0)",
      tick: "    if time.ticks_diff(time.ticks_ms(), _last[0]) < 30000 and _state['temp'] is not None:\n        return\n    _last[0] = time.ticks_ms()\n    try:\n        _dht.measure()\n        _state['temp'] = round(_dht.temperature(), 1)\n        _state['hum'] = round(_dht.humidity(), 1)\n    except Exception:\n        pass\n    _regulate()",
      read: "    return dict(_state)",
      cmd: "    if action == 'set':\n        if 'setpoint' in params: _state['setpoint'] = max(5.0, min(30.0, float(params['setpoint'])))\n        if 'mode' in params and params['mode'] in ('heat', 'off'): _state['mode'] = params['mode']\n        if 'on' in params: _state['mode'] = 'heat' if params['on'] else 'off'\n        if 'hyst' in params: _state['hyst'] = max(0.1, min(3.0, float(params['hyst'])))\n        _regulate()\n    _r = dict(_state); _r['ok'] = True\n    return _r",
    },
  },
};

export function typeMeta(t) { return CATALOG[t] || CATALOG.relay; }
