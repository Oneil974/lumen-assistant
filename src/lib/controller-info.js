// Aide-mémoire matériel du Lumen Controller, repris du firmware
// (`lumen-controller/README.md` et `WAVESHARE-2IN13.md`).
//
// Les numéros de broches et les noms de signaux (VCC, DIN, GP18…) ne se
// traduisent pas : seuls les rôles et les avertissements passent par l'i18n.
// Ces tableaux doivent rester synchronisés avec `lumen-controller/config.py`,
// qui fait foi côté firmware.

import { t } from "../i18n.js";

/// Brochage ESP32 : rôle → broches, dans l'ordre des signaux du firmware.
export const ESP32_PINS = [
  { role: "ctrl_role_screen", signals: "DIN · CLK · CS · DC · RST · BUSY", pins: "13 · 14 · 15 · 2 · 16 · 17" },
  { role: "ctrl_role_encoder", signals: "A · B", pins: "32 · 33" },
  { role: "ctrl_role_encoder_sw", signals: "SW", pins: "19" },
  { role: "ctrl_role_pot", signals: "{wiper} / ADC1", pins: "34" },
  { role: "ctrl_role_buttons", signals: "Backend · Mic · Mode", pins: "4 · 5 · 18" },
  { role: "ctrl_role_leds", signals: "DIN (WS2812B)", pins: "27" },
];

/// Brochage Pico W : GPIO **et** broche physique, les deux numérotations étant
/// la source d'erreur la plus fréquente au montage.
export const PICO_PINS = [
  { role: "ctrl_role_screen", signals: "DIN · CLK · CS · DC · RST · BUSY", pins: "GP11 · GP10 · GP9 · GP8 · GP12 · GP13", phys: "15 · 14 · 12 · 11 · 16 · 17" },
  { role: "ctrl_role_screen_power", signals: "VCC → VSYS · GND", pins: "VSYS", phys: "39 · 38" },
  { role: "ctrl_role_encoder", signals: "A · B", pins: "GP2 · GP3", phys: "4 · 5" },
  { role: "ctrl_role_encoder_sw", signals: "SW", pins: "GP17", phys: "22" },
  { role: "ctrl_role_pot", signals: "{wiper} / ADC0", pins: "GP26", phys: "31" },
  { role: "ctrl_role_buttons", signals: "Backend · Mic · Mode", pins: "GP14 · GP15 · GP16", phys: "19 · 20 · 21" },
  { role: "ctrl_role_leds", signals: "DIN (WS2812B) · VBUS 5 V", pins: "GP18", phys: "24 · 40" },
  { role: "ctrl_role_rfid", signals: "SDA/CS · SCK · MOSI · MISO · RST", pins: "GP5 · GP6 · GP7 · GP4 · GP22", phys: "7 · 9 · 10 · 6 · 29" },
];

/// Avertissements. `level: "danger"` = risque matériel réel (destruction ou
/// surcharge) ; les autres sont des limites de conception à connaître.
export const WARNINGS = [
  { key: "ctrl_warn_screen_variant", level: "warn" },
  { key: "ctrl_warn_pico_w", level: "warn" },
  { key: "ctrl_warn_adc_5v", level: "danger" },
  { key: "ctrl_warn_vsys", level: "danger" },
  { key: "ctrl_warn_leds_power", level: "danger" },
  { key: "ctrl_warn_boot_pins", level: "warn" },
  { key: "ctrl_warn_spi_order", level: "warn" },
  { key: "ctrl_warn_epaper_life", level: "warn" },
  { key: "ctrl_warn_usb_power", level: "info" },
  { key: "ctrl_warn_tcp_server", level: "info" },
  { key: "ctrl_warn_rfid_uid", level: "danger" },
  { key: "ctrl_warn_pot_absolute", level: "info" },
];

function pinTable(rows, withPhysical) {
  const table = document.createElement("table");
  table.className = "ctrl-pin-table";
  const head = document.createElement("tr");
  for (const label of [t("ctrl_col_role"), t("ctrl_col_signal"), withPhysical ? "GPIO" : t("ctrl_col_pin"), ...(withPhysical ? [t("ctrl_col_phys")] : [])]) {
    const th = document.createElement("th");
    th.textContent = label;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const row of rows) {
    const tr = document.createElement("tr");
    // `{wiper}` : seul mot traduisible d'une colonne par ailleurs technique.
    const signals = row.signals.replace("{wiper}", t("ctrl_sig_wiper"));
    const cells = [t(row.role), signals, row.pins, ...(withPhysical ? [row.phys || "—"] : [])];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  return table;
}

/// Rend les deux tableaux et la liste d'avertissements dans les Paramètres.
export function renderControllerInfo() {
  const esp = document.getElementById("ctrl-pins-esp32");
  const pico = document.getElementById("ctrl-pins-pico");
  const warns = document.getElementById("ctrl-warnings");
  if (!esp || !pico || !warns) return;

  esp.replaceChildren(pinTable(ESP32_PINS, false));
  pico.replaceChildren(pinTable(PICO_PINS, true));

  warns.replaceChildren();
  for (const warning of WARNINGS) {
    const li = document.createElement("li");
    li.className = `ctrl-warn ctrl-warn-${warning.level}`;
    li.textContent = t(warning.key);
    warns.appendChild(li);
  }
  ensureCss();
}

const CSS_ID = "controller-info-css";
function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.ctrl-pins { overflow-x: auto; margin: 6px 0 12px; }
.ctrl-pin-table { border-collapse: collapse; width: 100%; font-size: 11.5px; }
.ctrl-pin-table th, .ctrl-pin-table td {
  text-align: left; padding: 5px 8px; white-space: nowrap;
  border-bottom: 1px solid var(--line, var(--border));
}
.ctrl-pin-table th { color: var(--text-muted); font-weight: 600; }
.ctrl-pin-table td:nth-child(n+3) { font-variant-numeric: tabular-nums; }
.ctrl-warnings { margin: 6px 0 0; padding-left: 0; list-style: none; display: grid; gap: 6px; }
.ctrl-warn {
  font-size: 12px; line-height: 1.45; color: var(--text-muted);
  padding-left: 22px; position: relative;
}
.ctrl-warn::before { position: absolute; left: 0; top: 0; }
.ctrl-warn-danger::before { content: "⚠"; color: #ff9f0a; }
.ctrl-warn-warn::before { content: "!"; font-weight: 700; color: var(--accent-ink); }
.ctrl-warn-info::before { content: "i"; font-style: italic; font-weight: 700; color: var(--text-muted); }
.ctrl-warn-danger { color: var(--text); }
`;
  document.head.appendChild(style);
}
