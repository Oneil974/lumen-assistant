# -*- coding: utf-8 -*-
# Point d'entrée : écran + orbe + boucle de rendu + capteurs (+ réseau).

import time
import machine
import gc9a01 as lcd
import tft_config

import config as cfg
from themes import THEMES
from orb import Orb
from backlight import Backlight

try:
    import uasyncio as asyncio
except ImportError:
    import asyncio


def init_display():
    tft = tft_config.config(rotation=cfg.ROTATION)
    bl = Backlight(pin=cfg.PIN_BL if cfg.PIN_BL is not None else 2)
    bl.set(100)
    return tft, bl


def connect_wifi():
    import network
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        wlan.connect(cfg.WIFI_SSID, cfg.WIFI_PASS)
        for _ in range(100):          # 10 s max
            if wlan.isconnected():
                break
            time.sleep_ms(100)
    ip = wlan.ifconfig()[0] if wlan.isconnected() else None
    return ip, wlan


def sync_ntp():
    if not getattr(cfg, "NTP_ENABLE", False):
        return
    try:
        import ntptime
        ntptime.settime()
        print("NTP OK")
    except Exception as e:
        print("NTP:", e)


async def render_loop(orb):
    frame_ms = 1000 // cfg.FPS_CAP
    while True:
        t0 = time.ticks_ms()
        orb.render()
        dt = time.ticks_diff(time.ticks_ms(), t0)
        wait = frame_ms - dt
        await asyncio.sleep_ms(wait if wait > 0 else 0)


async def led_loop(leds):
    while True:
        try:
            leds.update()
        except Exception:
            pass
        await asyncio.sleep_ms(40)      # ~25 fps


async def control_loop(orb, sensors, ns):
    import sensors as S
    INFO_SCREENS = ("sensors", "agenda", "tasks", "status")
    last_pull = 0
    while True:
        # rafraîchissement auto tant qu'un écran d'info est ouvert
        if ns is not None and orb.screen in INFO_SCREENS:
            if time.ticks_diff(time.ticks_ms(), last_pull) > 8000:
                last_pull = time.ticks_ms()
                await ns.send({"cmd": "pull", "what": orb.screen})

        g, tx, ty = sensors.poll_event()
        if g:
            orb.note_activity()          # tout geste réveille + repousse la veille
            cmd = orb.handle_touch(tx, ty) if g == S.G_CLICK and tx is not None else orb.handle_gesture(g)
            if g == S.G_DOUBLE:
                orb.surprise()
            elif cmd == "dictation" and ns is not None:
                await ns.send({"cmd": "dictation"})
            elif cmd == "conversation":
                if ns is not None:
                    await ns.send({"cmd": "conversation"})
            elif cmd == "agent":
                if ns is not None:
                    await ns.send({"cmd": "agent_status"})
            elif cmd and cmd.startswith("pull:"):
                if ns is not None:
                    await ns.send({"cmd": "pull", "what": cmd[5:]})

        await asyncio.sleep_ms(50)


def _in_quiet(hour):
    s, e = cfg.QUIET_START, cfg.QUIET_END
    return (s <= hour or hour < e) if s > e else (s <= hour < e)


async def power_loop(orb, backlight):
    """Auto-dim + veille selon l'inactivité et les heures « nuit » ; horloge NTP."""
    while True:
        idle = time.ticks_diff(time.ticks_ms(), orb.last_activity)
        hour = None
        try:
            hour = (time.localtime()[3] + cfg.TZ_OFFSET) % 24
        except Exception:
            pass
        quiet = hour is not None and _in_quiet(hour)

        if idle > cfg.STANDBY_AFTER_MS or (quiet and idle > cfg.DIM_AFTER_MS):
            if not orb.standby:
                orb.set_standby(True)
                if backlight:
                    backlight.off()
        elif idle > cfg.DIM_AFTER_MS:
            if orb.standby:
                orb.set_standby(False)
            if backlight:
                backlight.set(cfg.DIM_LEVEL)
        else:
            if orb.standby:
                orb.set_standby(False)
            if backlight:
                backlight.set(orb.brightness)

        # Horloge : NTP (si pas d'heure poussée récemment par Lumen)
        if hour is not None and not orb.time_pushed_recently():
            lt = time.localtime()
            orb.set_time("%02d:%02d" % (hour, lt[4]))
        await asyncio.sleep_ms(1000)


async def health_loop(orb, wlan):
    """Watchdog matériel + reconnexion Wi-Fi durcie."""
    wdt = None
    if getattr(cfg, "WATCHDOG_MS", 0):
        try:
            wdt = machine.WDT(timeout=cfg.WATCHDOG_MS)
        except Exception as e:
            print("WDT:", e)
    ntp_done = wlan is not None and wlan.isconnected()
    while True:
        if wdt:
            wdt.feed()
        if wlan is not None:
            if not wlan.isconnected():
                orb.set_connected(False)
                try:
                    wlan.connect(cfg.WIFI_SSID, cfg.WIFI_PASS)
                except Exception:
                    pass
                ntp_done = False
            elif not ntp_done:
                orb.set_ip(wlan.ifconfig()[0])
                sync_ntp()
                ntp_done = True
        await asyncio.sleep_ms(2000)


async def main():
    machine.freq(240_000_000)               # CPU à fond (souvent bridé au boot)

    tft, backlight = init_display()
    orb = Orb(tft, cfg, THEMES, backlight)
    tft.fill(lcd.color565(0, 0, 0))

    # réseau (optionnel) : état entrant + commandes sortantes
    ns = None
    wlan = None
    if cfg.WIFI_ENABLE:
        ip, wlan = connect_wifi()
        print("WiFi:", ip)
        orb.set_connected(bool(ip))
        if ip:
            orb.set_ip(ip)             # secoue l'orbe pour l'afficher
            sync_ntp()                 # horloge à l'heure dès le boot
            from netstate import NetState
            ns = NetState(orb, cfg.NET_PORT)
            print("Orbe à l'écoute sur %s:%d" % (ip, cfg.NET_PORT))

    tasks = [asyncio.create_task(render_loop(orb))]
    tasks.append(asyncio.create_task(power_loop(orb, backlight)))
    tasks.append(asyncio.create_task(health_loop(orb, wlan)))

    # bandeau WS2812B synchronisé avec l'orbe — optionnel
    if getattr(cfg, "LED_ENABLE", False):
        try:
            from leds import Leds
            leds = Leds(cfg, orb)
            tasks.append(asyncio.create_task(led_loop(leds)))
        except Exception as e:
            print("LEDs désactivées:", e)

    # écran tactile CST816 — optionnel
    try:
        from sensors import Sensors
        sensors = Sensors()
        tasks.append(asyncio.create_task(control_loop(orb, sensors, ns)))
    except Exception as e:
        print("Capteurs désactivés:", e)

    if ns is not None:
        tasks.append(asyncio.create_task(ns.serve()))

    await asyncio.gather(*tasks)


try:
    asyncio.run(main())
finally:
    asyncio.new_event_loop()
