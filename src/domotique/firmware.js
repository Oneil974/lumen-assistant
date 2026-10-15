// Générateur de firmware MicroPython pour ESP32 / ESP32-S3 / Raspberry Pi Pico W.
// Produit un `main.py` autonome qui implémente le protocole « Lumen Local Device »
// (LLD) côté carte : connexion Wi-Fi, réponse à la découverte UDP, et serveur
// HTTP minimal avec vérification de signature HMAC-SHA256 — strictement le même
// contrat que le backend (src-tauri/src/domotique.rs).
//
// Une carte héberge N « composants » (capteurs ET actionneurs mélangés), chacun
// adressé par une CLÉ stable :
//   - GET  /state -> { "<clé>": <état>, ... }   (un sous-dict par composant)
//   - POST /cmd   <- { "component": "<clé>", "action": ..., "params": ... }
// Chaque composant est isolé dans son propre espace de noms (suffixe `_<i>`),
// si bien que deux composants du même type (ex. deux relais) cohabitent.

import { typeMeta } from "./catalog.js";

// Suffixe tous les identifiants locaux (préfixés « _ ») d'un fragment de template
// pour isoler le composant n°`i`. Ex. `_state` -> `_state_0`. Les modules et
// méthodes (machine, dht, .read_u16, ATTN_11DB…) ne commencent pas par « _ » et
// restent intacts.
function namespaced(code, i) {
  return (code || "").replace(/\b_[A-Za-z][A-Za-z0-9_]*\b/g, (m) => `${m}_${i}`);
}

// Normalise la liste des composants (compat ascendante mono-type) et garantit
// des clés uniques et stables.
export function normalizeComponents(opts) {
  let list = Array.isArray(opts.components) && opts.components.length
    ? opts.components
    : [{ type: opts.type, name: opts.name, pins: opts.pins }];

  const seen = new Set();
  return list.map((c, i) => {
    const type = c.type || "relay";
    // Clé par défaut lisible et stable : type + 1re broche (ex. relay_26).
    const pin0 = String(c.pins || typeMeta(type).pins || "").split(/[,\s]+/).filter(Boolean)[0] || i;
    let key = String(c.key || `${type}_${pin0}`).trim() || `${type}_${i}`;
    while (seen.has(key)) key = `${key}_${i}`;
    seen.add(key);
    return { key, type, name: c.name || type, pins: c.pins || "", count: c.count };
  });
}

export function buildFirmware(opts) {
  const components = normalizeComponents(opts);
  const imports = new Set();
  let blocks = "";
  const registry = [];
  const capsComponents = [];
  const ticks = [];

  components.forEach((c, i) => {
    const meta = typeMeta(c.type);
    const pins = (c.pins || meta.pins || "0").split(/[,\s]+/).filter(Boolean);
    const pin0 = pins[0] || "0";
    // Pour les types « à quantité » (bandeau LED), le 2e jeton de la broche est
    // le nombre de LEDs : ex. « 5, 3 » = broche 5, 3 LEDs.
    const count = (meta.extra && meta.extra.count)
      ? (parseInt(pins[1], 10) || c.count || meta.extra.count)
      : (c.count || 8);
    const pin1 = pins[1] || String(meta.pins || "").split(/[,\s]+/).filter(Boolean)[1] || "0";
    const fill = (s) => (s || "").replaceAll("{PIN0}", pin0).replaceAll("{PIN1}", pin1).replaceAll("{COUNT}", String(count));
    const ns = (s) => namespaced(fill(s), i);

    if (meta.fw.imports) imports.add(meta.fw.imports);

    const setup = ns(meta.fw.setup);
    const readBody = ns(meta.fw.read) || "    return {}";
    const cmdBody = ns(meta.fw.cmd) || "    return {'ok': False}";
    // Tâche périodique facultative (régulation du thermostat…), appelée par
    // la boucle principale toutes les ~2 s.
    const tickBody = ns(meta.fw.tick);
    if (tickBody) ticks.push(`_tick_${i}`);

    blocks +=
      `# --- composant « ${c.key} » : ${meta.label} (broche ${pin0}) ---\n` +
      `${setup}\n\n` +
      `def _read_${i}():\n${readBody}\n\n` +
      `def _cmd_${i}(action, params):\n${cmdBody}\n\n` +
      (tickBody ? `def _tick_${i}():\n${tickBody}\n\n` : "");

    registry.push(`    ${py(c.key)}: (_read_${i}, _cmd_${i}),`);
    capsComponents.push({ key: c.key, type: c.type, kind: meta.kind, name: c.name });
  });

  const extraImports = [...imports].join("\n");
  const caps = JSON.stringify({ components: capsComponents, ota: 1 });
  const devType = components.length > 1 ? "multi" : components[0].type;

  return `# === Firmware Lumen — ${opts.name} ===
# Protocole « Lumen Local Device » : decouverte UDP + controle HTTP signe HMAC.
# Genere par Lumen. Carte : ${opts.board}. Copier ce fichier comme main.py.
# Composants : ${components.map((c) => c.key).join(", ")}.

import network, socket, time, machine, json, uhashlib, select, os
${extraImports}

# ----- Configuration (injectee par Lumen) -----
SSID     = ${py(opts.ssid)}
PASSWORD = ${py(opts.password)}
SECRET   = ${py(opts.secret)}
DEV_ID   = ${py(opts.id)}
DEV_NAME = ${py(opts.name)}
DEV_TYPE = ${py(devType)}
CAPS     = ${caps}
HTTP_PORT = 80
DISCOVERY_PORT = 50001

# Fenetre de secours REPL : appuyer sur Ctrl+C juste apres reset pour interrompre
# main.py avant l'initialisation des composants (utile si un capteur bloque).
print("Lumen boot: Ctrl+C maintenant pour REPL (5 s)")
for _ in range(50):
    time.sleep_ms(100)

# ----- Composants (chacun isole dans son espace de noms) -----
${blocks}# ----- Registre clé -> (lecture, commande) -----
COMPONENTS = {
${registry.join("\n")}
}

TICKS = [${ticks.join(", ")}]

def run_ticks():
    for f in TICKS:
        try:
            f()
        except Exception as e:
            print("tick:", e)

def read_all_state():
    out = {}
    for k in COMPONENTS:
        try:
            out[k] = COMPONENTS[k][0]()
        except Exception as e:
            out[k] = {"err": str(e)}
    return out

def dispatch_cmd(component, action, params):
    # Tolerance : si un seul composant, on l'adresse meme sans cle explicite.
    if component is None and len(COMPONENTS) == 1:
        component = next(iter(COMPONENTS))
    entry = COMPONENTS.get(component)
    if not entry:
        return {"ok": False, "err": "composant inconnu: %s" % component}
    return entry[1](action, params)

# ----- Wi-Fi -----
def wifi_connect():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        wlan.connect(SSID, PASSWORD)
        for _ in range(40):
            if wlan.isconnected():
                break
            time.sleep(0.5)
    ip = wlan.ifconfig()[0]
    print("Wi-Fi:", ip)
    return ip

# ----- Horloge (pour la protection anti-rejeu) -----
def sync_time():
    try:
        import ntptime
        ntptime.settime()
    except Exception as e:
        print("NTP indisponible:", e)

# ----- HMAC-SHA256 (pas de module hmac garanti en MicroPython) -----
def _hmac(key, msg):
    block = 64
    if len(key) > block:
        key = uhashlib.sha256(key).digest()
    key = key + b"\\x00" * (block - len(key))
    o_pad = bytes(b ^ 0x5c for b in key)
    i_pad = bytes(b ^ 0x36 for b in key)
    inner = uhashlib.sha256(i_pad + msg).digest()
    return uhashlib.sha256(o_pad + inner).digest()

def _hex(d):
    return "".join("%02x" % b for b in d)

def _unix_now():
    now = time.time()
    # Sur certains ports MicroPython bare-metal, time.time() compte depuis 2000
    # au lieu de 1970. Lumen, lui, signe en timestamp Unix.
    try:
        if time.localtime(now)[0] >= 2024 and now < 2000000000:
            return now + 946684800
    except Exception:
        pass
    return now

_seen = []  # nonces recents -> anti-rejeu

def verify(method, path, body, ts, nonce, sig):
    if not sig:
        return False
    msg = "%s.%s.%s %s\\n%s" % (ts, nonce, method, path, body)
    expected = _hex(_hmac(SECRET.encode(), msg.encode()))
    if expected != sig:
        return False
    # Fenetre temporelle seulement si l'horloge est synchronisee (annee >= 2024).
    try:
        if time.localtime()[0] >= 2024:
            if abs(int(ts) - int(_unix_now())) > 60:
                return False
    except Exception:
        pass
    if nonce in _seen:
        return False
    _seen.append(nonce)
    if len(_seen) > 64:
        del _seen[0]
    return True

# ----- HTTP -----
def send(cl, code, body, ctype="application/json"):
    if isinstance(body, str):
        body = body.encode()
    cl.send("HTTP/1.1 %d OK\\r\\nContent-Type: %s\\r\\nAccess-Control-Allow-Origin: *\\r\\nConnection: close\\r\\nContent-Length: %d\\r\\n\\r\\n" % (code, ctype, len(body)))
    # Corps volumineux (photo de sonnette) : envoi complet, par morceaux.
    mv = memoryview(body)
    while len(mv):
        n = cl.send(mv[:1024])
        mv = mv[n if n else len(mv[:1024]):]

def handle_http(cl):
    try:
        cl.settimeout(3)
        raw = cl.recv(2048)
        if not raw:
            return
        # En-tetes complets, puis corps jusqu'a Content-Length (mise a jour OTA :
        # le main.py entier, bien plus que 2 Ko).
        while b"\\r\\n\\r\\n" not in raw and len(raw) < 8192:
            more = cl.recv(1024)
            if not more:
                break
            raw += more
        head_b, _, body_b = raw.partition(b"\\r\\n\\r\\n")
        head = head_b.decode("utf-8", "ignore")
        lines = head.split("\\r\\n")
        method, path, _ = (lines[0].split(" ") + ["", "", ""])[:3]
        headers = {}
        for l in lines[1:]:
            if ":" in l:
                k, v = l.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        try:
            need = int(headers.get("content-length", "0"))
        except Exception:
            need = 0
        if need > 65536:
            send(cl, 413, json.dumps({"err": "corps trop gros"}))
            return
        while len(body_b) < need:
            more = cl.recv(min(2048, need - len(body_b)))
            if not more:
                break
            body_b += more
        body = body_b.decode("utf-8", "ignore")

        # Info publique (pas de secret expose) : utile pour le diagnostic.
        if path == "/info" and method == "GET":
            send(cl, 200, json.dumps({"id": DEV_ID, "name": DEV_NAME, "type": DEV_TYPE, "caps": CAPS}))
            return
        # Toutes les autres routes exigent une signature valide.
        ok = verify(method, path, body, headers.get("x-lumen-ts", ""),
                    headers.get("x-lumen-nonce", ""), headers.get("x-lumen-sig", ""))
        if not ok:
            send(cl, 401, json.dumps({"err": "signature invalide"}))
            return

        if path == "/state":
            send(cl, 200, json.dumps(read_all_state()))
        elif path == "/cmd":
            try:
                data = json.loads(body) if body else {}
            except Exception:
                data = {}
            res = dispatch_cmd(data.get("component"), data.get("action", "set"), data.get("params", data))
            send(cl, 200, json.dumps(res))
        elif path == "/ota" and method == "POST":
            ota_apply(cl, body)
        else:
            send(cl, 404, json.dumps({"err": "route inconnue"}))
    except Exception as e:
        try:
            send(cl, 500, json.dumps({"err": str(e)}))
        except Exception:
            pass
    finally:
        cl.close()

# ----- Mise a jour par Wi-Fi (OTA) -----
# POST /ota signe : {"code": <nouveau main.py>, "sha256": <empreinte hex>}.
# Le fichier est ecrit a cote, verifie, puis echange avec main.py ; l'ancien
# reste en main_old.py (secours : le renommer depuis le REPL). Redemarrage.
def ota_apply(cl, body):
    try:
        data = json.loads(body)
        code = data.get("code") or ""
        want = (data.get("sha256") or "").lower()
    except Exception:
        send(cl, 400, json.dumps({"ok": False, "err": "JSON invalide"}))
        return
    raw = code.encode()
    if not raw or _hex(uhashlib.sha256(raw).digest()) != want:
        send(cl, 400, json.dumps({"ok": False, "err": "empreinte invalide"}))
        return
    if "SECRET" not in code or "/ota" not in code:
        send(cl, 400, json.dumps({"ok": False, "err": "firmware Lumen OTA attendu"}))
        return
    with open("main_new.py", "w") as f:
        f.write(code)
    try:
        os.remove("main_old.py")
    except OSError:
        pass
    try:
        os.rename("main.py", "main_old.py")
    except OSError:
        pass
    os.rename("main_new.py", "main.py")
    send(cl, 200, json.dumps({"ok": True, "bytes": len(raw), "reboot": True}))
    cl.close()
    time.sleep_ms(400)
    machine.reset()

# ----- Boucle principale : HTTP + decouverte UDP -----
def serve(ip):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", HTTP_PORT))
    srv.listen(2)

    disc = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    disc.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    disc.bind(("0.0.0.0", DISCOVERY_PORT))

    poll = select.poll()
    poll.register(srv, select.POLLIN)
    poll.register(disc, select.POLLIN)
    announce = json.dumps({"id": DEV_ID, "name": DEV_NAME, "type": DEV_TYPE,
                           "ip": ip, "port": HTTP_PORT, "caps": CAPS}).encode()
    print("Lumen device pret:", DEV_NAME)

    while True:
        run_ticks()
        for sock, ev in poll.poll(2000):
            if sock is srv:
                cl, _ = srv.accept()
                handle_http(cl)
            elif sock is disc:
                try:
                    msg, addr = disc.recvfrom(256)
                    if b"discover" in msg:
                        disc.sendto(announce, addr)
                except Exception:
                    pass

# ----- Demarrage -----
def main():
    ip = wifi_connect()
    sync_time()
    while True:
        try:
            serve(ip)
        except Exception as e:
            print("Erreur serveur, reprise:", e)
            time.sleep(2)

main()
`;
}

// Litteral chaine Python sur (les valeurs viennent de l'utilisateur).
function py(s) {
  return JSON.stringify(String(s == null ? "" : s));
}
