// Domotique — logique front. Gère la liste des objets connectés, leur contrôle
// direct (widgets selon le type) et la génération de firmwares MicroPython. Le
// pilotage en langage naturel passe par les barres de chat Lumen. Le réseau passe par le backend Rust :
//   - domotique_discover : sonde UDP broadcast -> annonces des cartes
//   - domotique_call     : requête HTTP signée HMAC vers une carte
//   - domotique_devices_load/save : persistance de la liste (clés comprises)

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};

import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { translatePage, tt, observeTranslations } from "../apps-i18n.js";
import { CATALOG, BOARDS, typeMeta } from "./catalog.js";
import { buildFirmware, normalizeComponents } from "./firmware.js";
import { initPlan, renderPlan, notePlanState } from "./plan.js";
import { home, initHome, renderRoomBar, inRoom, renderScenes, renderRules, recordReading, sparkline, sensorFields, runScene, sceneByRef, historyCsv } from "./home.js";

// Composants d'un device. Compat ascendante : un objet mono-type hérité (sans
// champ `components`) expose un composant unique à clé `null` — son /state est
// alors « plat » (pas de sous-dict par composant).
function deviceComponents(dev) {
  if (Array.isArray(dev.components) && dev.components.length) return dev.components;
  return [{ key: null, type: dev.type, name: dev.name, pins: "" }];
}

import { mountAiPrompt, tool, T } from "../lib/ai-prompt.js?v=5";

let devices = [];        // [{id,name,type,ip,port,secret,room}]
let pollTimer = null;
let editingId = null;

// ===== Persistance =====
async function loadDevices() {
  try {
    const raw = await invoke("domotique_devices_load");
    devices = raw ? JSON.parse(raw) : [];
  } catch { devices = []; }
}
async function saveDevices() {
  try { await invoke("domotique_devices_save", { data: JSON.stringify(devices) }); } catch {}
}

function genKey() {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function genId() { return "dev-" + genKey().slice(0, 8); }

// ===== Appel d'un objet =====
async function call(dev, method, path, bodyObj) {
  return invoke("domotique_call", {
    ip: dev.ip, port: Number(dev.port) || 80, method,
    path, body: bodyObj ? JSON.stringify(bodyObj) : "", secret: dev.secret || "",
  });
}

function isAuthError(e) {
  return /401|unauthorized|signature invalide|refusé/i.test(String(e?.message || e || ""));
}

function authHint(dev) {
  return dev.secret
    ? tt("Clé partagée différente de celle du firmware. Ouvre ⚙︎ et recopie la clé du main.py.")
    : tt("Clé partagée manquante. Ouvre ⚙︎ et colle la valeur SECRET du main.py.");
}

// ===== Assistant IA (boîte de prompt partagée) =====
// Pilotage en langage naturel : allumer, éteindre, régler, interroger l'état,
// nommer, ranger par pièce, jouer une scène sur plusieurs objets d'un coup.
// Les appels passent par les mêmes commandes backend que la barre de Lumen.
const devByRef = (ref) => {
  const r = String(ref || "").trim().toLowerCase();
  return devices.find((d) => d.id === ref)
    || devices.find((d) => (d.name || "").toLowerCase() === r)
    || devices.find((d) => (d.name || "").toLowerCase().includes(r));
};
const devLine = (d) => `${d.id} · ${d.name} (${d.type}${d.room ? ", " + d.room : ""}) — ${d.ip || "sans IP"}`;

const DOMO_TOOLS = [
  tool("list_devices", "Liste les objets connectés : nom, type, pièce, adresse.", {}),
  tool("device_state", "Lit l'état courant d'un objet.", { device: T.str("Nom ou identifiant") }, ["device"]),
  tool("device_command", "Envoie une commande à un objet (allumer, éteindre, régler une valeur).",
    { device: T.str("Nom ou identifiant"), action: T.str("Action : on, off, toggle, set…"),
      component: T.str("Composant visé si l'objet en a plusieurs"),
      params: { type: "object", description: "Paramètres de l'action (ex. { \"value\": 128 })" } },
    ["device", "action"]),
  tool("scene", "Applique une même commande à plusieurs objets (scène).",
    { devices: T.list("Noms ou identifiants"), action: T.str("Action à appliquer"),
      params: { type: "object", description: "Paramètres" } }, ["devices", "action"]),
  tool("rename_device", "Renomme un objet et/ou lui affecte une pièce.",
    { device: T.str(""), name: T.str("Nouveau nom"), room: T.str("Pièce") }, ["device"]),
  tool("discover", "Scanne le réseau local à la recherche de nouveaux objets.", {}),
  tool("list_scenes", "Liste les scènes enregistrées (nom et nombre de commandes).", {}),
  tool("run_scene", "Lance une scène enregistrée par son nom.", { scene: T.str("Nom de la scène") }, ["scene"]),
  tool("list_rules", "Liste les automatisations (déclencheur, action, active ou non).", {}),
];

async function runDomoTool(name, a) {
  const need = (ref) => { const d = devByRef(ref); if (!d) throw new Error(`aucun objet « ${ref} ». Appelle list_devices.`); return d; };
  switch (name) {
    case "list_devices":
      return devices.length ? devices.map(devLine).join("\n") : "Aucun objet enregistré.";
    case "device_state": {
      const d = need(a.device);
      try { return `${d.name} : ${await call(d, "GET", "/state")}`; }
      catch (e) { return `${d.name} injoignable (${e?.message || e}).`; }
    }
    case "device_command": {
      const d = need(a.device);
      const body = { action: String(a.action), ...(a.component ? { component: String(a.component) } : {}),
        ...(a.params && typeof a.params === "object" ? a.params : {}) };
      const out = await call(d, "POST", "/cmd", body);
      return `${d.name} ← ${a.action} : ${String(out).slice(0, 160)}`;
    }
    case "scene": {
      const targets = (a.devices || []).map(need);
      const results = [];
      for (const d of targets) {
        try {
          await call(d, "POST", "/cmd", { action: String(a.action), ...(a.params || {}) });
          results.push(`${d.name} ✓`);
        } catch (e) { results.push(`${d.name} ✗ (${e?.message || e})`); }
      }
      return results.join(", ");
    }
    case "rename_device": {
      const d = need(a.device);
      if (a.name) d.name = String(a.name);
      if (a.room != null) d.room = String(a.room);
      await saveDevices();
      return `Mis à jour : ${devLine(d)}`;
    }
    case "discover": {
      const raw = await invoke("domotique_discover", { timeoutMs: 1800 });
      const found = JSON.parse(raw || "[]");
      return found.length ? `${found.length} objet(s) détecté(s) : ` + found.map((f) => f.name || f.ip).join(", ") : "Aucun objet détecté sur le réseau.";
    }
    case "list_scenes":
      return home.scenes.length ? home.scenes.map((sc) => `${sc.name} (${(sc.steps || []).length} commande(s))`).join("\n") : "Aucune scène enregistrée.";
    case "run_scene":
      return await runScene(a.scene);
    case "list_rules":
      return home.rules.length ? home.rules.map((r) => `${r.enabled ? "✓" : "✗"} ${r.name}`).join("\n") : "Aucune automatisation.";
    default: return `Outil inconnu : ${name}`;
  }
}

function mountDomoAI() {
  mountAiPrompt(null, {
    app: "Domotique",
    intro: "Tu pilotes les objets connectés de la maison et tu réponds sur leur état.",
    rules: "- Appelle list_devices avant d'agir : les noms viennent de l'utilisateur, pas de toi.\n- Pour plusieurs objets à la fois, utilise scene.\n- Si un objet est injoignable, dis-le clairement au lieu de prétendre avoir agi.",
    placeholder: "Ex. : éteins tout au rez-de-chaussée et allume la lampe du salon…",
    suggestions: [
      { label: "État de la maison", prompt: "Fais le point sur l'état de tous mes objets connectés." },
      { label: "Tout éteindre", prompt: "Éteins tous les objets qui peuvent l'être." },
      { label: "Scène soirée", prompt: "Prépare une scène soirée : lumières douces dans le salon, le reste éteint." },
      { label: "Chercher", prompt: "Scanne le réseau et dis-moi ce que tu trouves de nouveau." },
    ],
    tools: DOMO_TOOLS,
    context: () => devices.length ? devices.map(devLine).join("\n") : "Aucun objet enregistré.",
    execute: runDomoTool,
    onApplied: () => renderDevices(),
  });
}

// ===== Onglets =====
function setupTabs() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      document.querySelectorAll(".panel").forEach((p) =>
        p.classList.toggle("active", p.dataset.panel === t.dataset.tab));
    }));
}

// ===== Rendu des objets =====
function renderDevices() {
  const grid = document.getElementById("devices-grid");
  document.getElementById("devices-empty").hidden = devices.length > 0;
  renderRoomBar(document.getElementById("room-bar"));
  grid.textContent = "";
  for (const dev of devices.filter(inRoom)) grid.appendChild(deviceCard(dev));
}

function deviceCard(dev) {
  const comps = deviceComponents(dev);
  const headMeta = typeMeta(comps[0].type);
  const card = document.createElement("div");
  card.className = "dev-card"; card.dataset.id = dev.id;

  const head = document.createElement("div");
  head.className = "dev-head";
  head.innerHTML =
    `<div class="dev-icon" style="background:${headMeta.color}"><svg viewBox="0 0 24 24">${headMeta.icon}</svg></div>` +
    `<div><div class="dev-title"></div><div class="dev-sub"></div></div>` +
    `<button class="dev-edit" title="Modifier">⚙︎</button>` +
    `<span class="dev-status" title="Statut"></span>`;
  head.querySelector(".dev-title").textContent = dev.name;
  const sub = comps.length > 1 ? tt("{n} composants", { n: comps.length }) : "";
  head.querySelector(".dev-sub").textContent =
    `${dev.room ? dev.room + " · " : ""}${dev.ip || "—"}${sub ? " · " + sub : ""}`;
  head.querySelector(".dev-edit").addEventListener("click", () => openDeviceModal(dev));
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "dev-body";
  card.appendChild(body);
  if (!dev.secret) {
    const warn = document.createElement("div");
    warn.className = "auth-warn";
    warn.textContent = tt("Clé partagée à renseigner pour piloter cet objet.");
    card.appendChild(warn);
  }
  for (const comp of comps) body.appendChild(componentBlock(dev, comp, card, comps.length > 1));

  refreshDevice(dev, card);   // première lecture
  return card;
}

function setStatus(card, online) {
  const s = card.querySelector(".dev-status");
  if (s) s.className = "dev-status " + (online ? "online" : "offline");
}

// Un bloc d'UI par composant. En multi, un en-tête (icône + nom) le coiffe.
function componentBlock(dev, comp, card, multi) {
  const meta = typeMeta(comp.type);
  const wrap = document.createElement("div");
  wrap.className = "comp-block";
  wrap.dataset.compKey = comp.key == null ? "" : comp.key;
  if (multi) {
    const h = document.createElement("div");
    h.className = "comp-head";
    h.innerHTML = `<span class="comp-ic" style="background:${meta.color}"><svg viewBox="0 0 24 24">${meta.icon}</svg></span><span class="comp-name"></span>`;
    h.querySelector(".comp-name").textContent = tt(comp.name || meta.label);
    wrap.appendChild(h);
  }
  const inner = document.createElement("div");
  wrap.appendChild(inner);
  buildComponentControls(dev, comp, meta, inner, card);
  return wrap;
}

// Construit les widgets d'UN composant selon son type. Lit via /state, agit via
// /cmd (en injectant la clé du composant si l'objet est multi-composants).
function buildComponentControls(dev, comp, meta, body, card) {
  const t = comp.type;
  if (meta.kind === "sensor") {
    body.innerHTML = `<div class="dev-readings muted">${tt("Lecture…")}</div>`;
    return;
  }
  // Actionneurs
  if (t === "relay") {
    body.appendChild(toggleRow("Activé", false, (on) => act(dev, comp, { action: "set", params: { on } }, card)));
  } else if (t === "dimmer") {
    body.appendChild(toggleRow("Allumé", false, (on) => act(dev, comp, { action: "set", params: { on } }, card)));
    body.appendChild(sliderRow("Intensité", 0, 100, 100, (v) => act(dev, comp, { action: "set", params: { brightness: v } }, card)));
  } else if (t === "rgb") {
    body.appendChild(toggleRow("Allumé", false, (on) => act(dev, comp, { action: "set", params: { on } }, card)));
    const color = document.createElement("div");
    color.className = "row";
    color.innerHTML = `<span class="label">${tt("Couleur")}</span><span class="spacer"></span><input type="color" value="#ffffff">`;
    color.querySelector("input").addEventListener("change", (e) => {
      const { r, g, b } = hexToRgb(e.target.value);
      act(dev, comp, { action: "set", params: { r, g, b, on: true } }, card);
    });
    body.appendChild(color);
    body.appendChild(sliderRow("Intensité", 0, 100, 100, (v) => act(dev, comp, { action: "set", params: { brightness: v } }, card)));
  } else if (t === "matrix8") {
    body.appendChild(toggleRow("Affichage", false, (on) => act(dev, comp, { action: "set", params: { on } }, card)));
    const color = document.createElement("div");
    color.className = "row";
    color.innerHTML = `<span class="label">${tt("Couleur")}</span><span class="spacer"></span><input type="color" value="#40b4ff">`;
    color.querySelector("input").addEventListener("change", (e) => {
      const { r, g, b } = hexToRgb(e.target.value);
      act(dev, comp, { action: "set", params: { r, g, b, on: true } }, card);
    });
    body.appendChild(color);
    body.appendChild(sliderRow("Luminosité", 1, 100, 35, (v) => act(dev, comp, { action: "set", params: { brightness: v, on: true } }, card)));
    body.appendChild(matrixEditor(dev, comp, card));

    const faces = document.createElement("div");
    faces.className = "matrix-actions";
    [
      ["idle", "Repos"],
      ["happy", "Joyeux"],
      ["think", "Réfléchir"],
      ["alert", "Alerte"],
      ["ok", "OK"],
      ["heart", "Cœur"],
    ].forEach(([status, label]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "matrix-btn";
      btn.textContent = tt(label);
      btn.addEventListener("click", () => act(dev, comp, { action: "status", params: { status } }, card));
      faces.appendChild(btn);
    });
    body.appendChild(faces);
  } else if (t === "thermostat") {
    body.innerHTML = `<div class="dev-readings muted">${tt("Lecture…")}</div>`;
    body.appendChild(toggleRow("Chauffage actif", true, (on) => act(dev, comp, { action: "set", params: { mode: on ? "heat" : "off" } }, card)));
    const sp = document.createElement("div");
    sp.className = "row thermo-row";
    sp.innerHTML = `<span class="label">${tt("Consigne")}</span><span class="spacer"></span>
      <button type="button" class="btn-soft thermo-dec">−</button><b class="thermo-sp">—</b><button type="button" class="btn-soft thermo-inc">+</button>`;
    const bump = async (d) => {
      const cur = parseFloat(sp.dataset.sp || "20");
      const next = Math.max(5, Math.min(30, Math.round((cur + d) * 2) / 2));
      sp.dataset.sp = String(next); sp.querySelector(".thermo-sp").textContent = `${next} °C`;
      await act(dev, comp, { action: "set", params: { setpoint: next } }, card);
    };
    sp.querySelector(".thermo-dec").addEventListener("click", () => bump(-0.5));
    sp.querySelector(".thermo-inc").addEventListener("click", () => bump(0.5));
    body.appendChild(sp);
  } else if (t === "servo") {
    body.appendChild(sliderRow("Angle", 0, 180, 90, (v) => act(dev, comp, { action: "set", params: { angle: v } }, card)));
  } else {
    body.innerHTML = `<div class="muted">${tt("Type non reconnu.")}</div>`;
  }
}

function matrixEditor(dev, comp, card) {
  const wrap = document.createElement("div");
  wrap.className = "matrix-editor";
  const pixels = Array(64).fill(null);
  let paintColor = "#40b4ff";
  let erasing = false;
  let drawing = false;

  wrap.innerHTML =
    `<div class="matrix-tools">` +
    `<input type="color" value="${paintColor}" title="${tt("Couleur du pinceau")}">` +
    `<button type="button" class="matrix-btn matrix-erase">${tt("Gomme")}</button>` +
    `<button type="button" class="matrix-btn matrix-send">${tt("Envoyer")}</button>` +
    `<button type="button" class="matrix-btn matrix-clear">${tt("Effacer")}</button>` +
    `</div><div class="matrix-canvas" role="grid" aria-label="${tt("Dessin matrice 8 par 8")}"></div>`;

  const color = wrap.querySelector("input");
  const grid = wrap.querySelector(".matrix-canvas");
  const eraseBtn = wrap.querySelector(".matrix-erase");
  const sendBtn = wrap.querySelector(".matrix-send");
  const clearBtn = wrap.querySelector(".matrix-clear");

  const paint = (idx) => {
    pixels[idx] = erasing ? null : paintColor;
    const cell = grid.children[idx];
    cell.style.background = pixels[idx] || "";
    cell.classList.toggle("on", !!pixels[idx]);
  };

  for (let i = 0; i < 64; i++) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "matrix-cell";
    cell.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      drawing = true;
      cell.setPointerCapture?.(e.pointerId);
      paint(i);
    });
    cell.addEventListener("pointerenter", () => { if (drawing) paint(i); });
    cell.addEventListener("pointerup", () => { drawing = false; });
    grid.appendChild(cell);
  }
  document.addEventListener("pointerup", () => { drawing = false; });

  color.addEventListener("change", (e) => {
    paintColor = e.target.value;
    erasing = false;
    eraseBtn.classList.remove("active");
  });
  eraseBtn.addEventListener("click", () => {
    erasing = !erasing;
    eraseBtn.classList.toggle("active", erasing);
  });
  sendBtn.addEventListener("click", () => act(dev, comp, { action: "draw", params: { pixels } }, card));
  clearBtn.addEventListener("click", () => {
    pixels.fill(null);
    [...grid.children].forEach((cell) => { cell.style.background = ""; cell.classList.remove("on"); });
    act(dev, comp, { action: "clear", params: {} }, card);
  });

  return wrap;
}

function toggleRow(label, checked, onChange) {
  const row = document.createElement("label");
  row.className = "row";
  row.innerHTML = `<span class="label">${tt(label)}</span><span class="spacer"></span>` +
    `<span class="toggle"><input type="checkbox"><span class="track"></span><span class="knob"></span></span>`;
  const cb = row.querySelector("input"); cb.checked = checked;
  cb.addEventListener("change", () => onChange(cb.checked));
  return row;
}
function sliderRow(label, min, max, val, onChange) {
  const wrap = document.createElement("div");
  wrap.innerHTML = `<div class="row"><span class="label">${tt(label)}</span><span class="spacer"></span><span class="val muted">${val}</span></div>` +
    `<input type="range" min="${min}" max="${max}" value="${val}">`;
  const out = wrap.querySelector(".val"), range = wrap.querySelector("input");
  range.addEventListener("input", () => (out.textContent = range.value));
  range.addEventListener("change", () => onChange(Number(range.value)));
  return wrap;
}

async function act(dev, comp, payload, card) {
  const body = comp.key == null ? payload : { ...payload, component: comp.key };
  try { await call(dev, "POST", "/cmd", body); setStatus(card, true); }
  catch (e) { setStatus(card, false); toast(isAuthError(e) ? authHint(dev) : tt("Échec :") + " " + (e.message || e)); }
}

// Sélectionne le bloc DOM d'un composant (clé `null` => objet mono, bloc unique).
function compBlock(card, comp) {
  const key = comp.key == null ? "" : comp.key;
  return card.querySelector(`.comp-block[data-comp-key="${CSS.escape(key)}"]`) || card;
}

// Lecture périodique de l'état (capteurs + reflet des actionneurs). Le /state
// d'un objet multi est keyé par composant ; l'hérité mono renvoie un dict plat.
async function refreshDevice(dev, card) {
  if (!dev.ip) return;
  try {
    const txt = await call(dev, "GET", "/state", null);
    const st = JSON.parse(txt);
    setStatus(card, true);
    notePlanState(dev, true, st);
    for (const comp of deviceComponents(dev)) {
      const sub = comp.key == null ? st : (st[comp.key] || {});
      paintComponent(dev, comp, card, sub);
    }
  } catch { setStatus(card, false); notePlanState(dev, false, null); }
}

function paintComponent(dev, comp, card, st) {
  const meta = typeMeta(comp.type);
  const block = compBlock(card, comp);
  if (comp.type === "thermostat") {
    const cb = block.querySelector(".toggle input");
    if (cb && st.mode) cb.checked = st.mode === "heat";
    const sp = block.querySelector(".thermo-row");
    if (sp && st.setpoint != null) { sp.dataset.sp = String(st.setpoint); sp.querySelector(".thermo-sp").textContent = `${st.setpoint} °C`; }
    const box = block.querySelector(".dev-readings");
    if (box) {
      box.classList.remove("muted");
      box.innerHTML = reading(st.temp, "°C", "Température") + reading(st.hum, "%", "Humidité") + badge(st.heating ? "Chauffe" : "À l'arrêt", !!st.heating);
    }
    recordReading(dev, comp, st);
    return;
  }
  if (meta.kind !== "sensor") {
    // reflète l'état réel sur les widgets sans déclencher d'événement
    const cb = block.querySelector(".toggle input");
    if (cb && typeof st.on === "boolean") cb.checked = st.on;
    return;
  }
  const box = block.querySelector(".dev-readings");
  if (!box) return;
  if (st && !st.err) recordReading(dev, comp, st);
  box.classList.remove("muted");
  if (st && st.err) { box.innerHTML = badge("Erreur capteur", false); return; }
  if (comp.type === "temperature") {
    box.innerHTML = reading(st.temp, "°C", "Température") + reading(st.hum, "%", "Humidité");
  } else if (comp.type === "light_sensor") {
    box.innerHTML = reading(st.level, "%", "Luminosité");
  } else if (comp.type === "presence") {
    box.innerHTML = badge(st.motion ? "Présence détectée" : "Aucun mouvement", st.motion);
  } else if (comp.type === "contact") {
    box.innerHTML = badge(st.open ? "Ouvert" : "Fermé", st.open);
  } else if (comp.type === "co2") {
    box.innerHTML = reading(st.co2, "ppm", "CO₂") + reading(st.temp, "°C", "Température") + reading(st.hum, "%", "Humidité")
      + badge(st.co2 >= 1200 ? "Aérer" : st.co2 >= 800 ? "Air moyen" : "Air sain", st.co2 < 800);
  } else if (comp.type === "particles") {
    box.innerHTML = reading(st.pm25, "µg/m³", "PM2.5") + reading(st.pm10, "µg/m³", "PM10") + reading(st.pm1, "µg/m³", "PM1")
      + badge(st.pm25 > 35 ? "Air pollué" : st.pm25 > 15 ? "Air moyen" : "Air sain", st.pm25 <= 15);
  } else if (comp.type === "water_leak") {
    box.innerHTML = badge(st.leak ? "Fuite détectée !" : "Aucune fuite", !st.leak);
    if (st.leak) box.classList.add("alarm"); else box.classList.remove("alarm");
  } else if (comp.type === "doorbell") {
    const when = st.last_ring ? new Date(st.last_ring * 1000).toLocaleTimeString() : "—";
    box.innerHTML = badge(st.ring ? "On sonne !" : `${tt("Dernier appui")} : ${when}`, !!st.ring)
      + `<button type="button" class="btn-soft doorbell-snap"${st.camera ? "" : " disabled"}>${tt("Photo")}</button><img class="doorbell-img" hidden alt="">`;
    box.querySelector(".doorbell-snap").addEventListener("click", async () => {
      try {
        const body = comp.key == null ? { action: "snapshot" } : { action: "snapshot", component: comp.key };
        const res = JSON.parse(await call(dev, "POST", "/cmd", body));
        if (!res.jpeg) throw new Error(res.err || "pas d'image");
        const img = box.querySelector(".doorbell-img"); img.src = `data:image/jpeg;base64,${res.jpeg}`; img.hidden = false;
      } catch (e) { toast(tt("Échec :") + " " + (e.message || e)); }
    });
  } else {
    box.textContent = JSON.stringify(st);
  }
  const sparks = sensorFields(comp.type).map((f) => sparkline(dev, comp, f)).filter(Boolean).join("");
  if (sparks) box.insertAdjacentHTML("beforeend", `<div class="sparks">${sparks}</div>`);
}
function reading(v, unit, lbl) {
  return `<div class="reading"><span class="val">${v ?? "—"}</span><span class="unit">${unit}</span><span class="lbl">${tt(lbl)}</span></div>`;
}
function badge(text, on) {
  const col = on ? "var(--green)" : "var(--text-muted)";
  return `<div class="reading"><span class="dev-status ${on ? "online" : ""}" style="background:${col}"></span>&nbsp;<span>${tt(text)}</span></div>`;
}
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

let polling = false;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (polling) return; // évite d'empiler les cycles si des objets sont lents
    polling = true;
    try {
      // Tous les objets, même filtrés par pièce : le plan et les
      // automatisations ont besoin de leur état.
      await Promise.allSettled(devices.map((dev) => refreshDevice(dev, cardOf(dev))));
    } finally { polling = false; }
  }, 6000);
}

// ===== Découverte réseau =====
async function scan() {
  const btn = document.getElementById("btn-scan");
  btn.disabled = true; btn.textContent = tt("Scan…");
  try {
    const raw = await invoke("domotique_discover", { timeoutMs: 1800 });
    const found = JSON.parse(raw || "[]");
    let added = 0;
    for (const f of found) {
      const comps = (f.caps && Array.isArray(f.caps.components)) ? f.caps.components : [];
      const existing = devices.find((d) => d.id === f.id);
      if (existing) {
        existing.ip = f.ip; existing.port = f.port; existing.name = existing.name || f.name;
        // La carte fait foi sur sa composition : on resynchronise à CHAQUE
        // découverte (clés/types), pour suivre un reflash qui a changé les
        // composants. Sans ça, une clé périmée fait échouer /cmd silencieusement.
        if (comps.length) { existing.components = comps; existing.type = f.type || existing.type; }
      } else {
        devices.push({ id: f.id, name: f.name || tt("Objet"), type: f.type || "relay", ip: f.ip, port: f.port || 80, secret: "", room: "", components: comps });
        added++;
      }
    }
    await saveDevices(); renderDevices();
    toast(found.length ? tt("{found} objet(s) détecté(s){added}.", { found: found.length, added: added ? tt(", {n} ajouté(s)", { n: added }) : "" }) : tt("Aucun objet détecté sur le réseau."));
    if (added) toast("Pensez à renseigner la clé partagée des nouveaux objets (⚙︎).");
  } catch (e) {
    toast(tt("Échec du scan :") + " " + (e.message || e));
  } finally {
    btn.disabled = false; btn.textContent = "⟳ " + tt("Découvrir");
  }
}

// ===== Modale ajout / édition =====
function fillTypeSelect(sel, board) {
  sel.innerHTML = "";
  for (const [id, m] of Object.entries(CATALOG)) {
    if (board && !m.boards.includes(board)) continue;
    const o = document.createElement("option"); o.value = id; o.textContent = tt(m.label); sel.appendChild(o);
  }
}
function openDeviceModal(dev) {
  editingId = dev ? dev.id : null;
  document.getElementById("dev-modal-title").textContent = dev ? tt("Modifier l'objet") : tt("Ajouter un objet");
  fillTypeSelect(document.getElementById("dev-type"));
  document.getElementById("dev-name").value = dev?.name || "";
  document.getElementById("dev-type").value = dev?.type || "relay";
  document.getElementById("dev-ip").value = dev?.ip || "";
  document.getElementById("dev-port").value = dev?.port || 80;
  document.getElementById("dev-room").value = dev?.room || "";
  document.getElementById("dev-secret").value = dev?.secret || genKey();
  document.getElementById("dev-delete").hidden = !dev;
  document.getElementById("dev-overlay").hidden = false;
}
function closeDeviceModal() { document.getElementById("dev-overlay").hidden = true; }
async function saveDeviceModal() {
  const existing = editingId ? devices.find((x) => x.id === editingId) : null;
  const d = {
    id: editingId || genId(),
    name: document.getElementById("dev-name").value.trim() || tt("Objet"),
    type: document.getElementById("dev-type").value,
    ip: document.getElementById("dev-ip").value.trim(),
    port: Number(document.getElementById("dev-port").value) || 80,
    room: document.getElementById("dev-room").value.trim(),
    secret: document.getElementById("dev-secret").value.trim(),
    // Les composants se définissent à la génération du firmware ; on les préserve.
    components: existing?.components || [],
  };
  const i = devices.findIndex((x) => x.id === d.id);
  if (i >= 0) devices[i] = d; else devices.push(d);
  await saveDevices(); renderDevices(); closeDeviceModal();
}
async function deleteDevice() {
  devices = devices.filter((x) => x.id !== editingId);
  await saveDevices(); renderDevices(); closeDeviceModal();
}

// ===== Onglet Firmware =====
// Liste de travail des composants en cours d'édition : [{type, name, pins}].
let fwComps = [{ type: "relay", name: "", pins: "" }];

function regenFirmware() {
  const code = currentFirmware();
  document.getElementById("fw-code").textContent = code.code;
  document.getElementById("fw-filename").textContent = code.filename;
}

// Rend l'éditeur de composants (une ligne par composant : type, nom, broche).
function renderCompEditor() {
  const board = document.getElementById("fw-board").value;
  const host = document.getElementById("fw-components");
  host.textContent = "";
  fwComps.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "comp-row";

    const typeSel = document.createElement("select");
    typeSel.className = "select comp-type";
    fillTypeSelect(typeSel, board);
    if (![...typeSel.options].some((o) => o.value === c.type)) c.type = typeSel.options[0]?.value || "relay";
    typeSel.value = c.type;
    typeSel.addEventListener("change", () => {
      c.type = typeSel.value;
      c.pins = typeMeta(c.type).pins || "";   // broche par défaut du nouveau type
      renderCompEditor(); regenFirmware();
    });

    const nameInput = document.createElement("input");
    nameInput.className = "input comp-name";
    nameInput.placeholder = tt(typeMeta(c.type).label);
    nameInput.value = c.name || "";
    nameInput.addEventListener("input", () => { c.name = nameInput.value; regenFirmware(); });

    const pinInput = document.createElement("input");
    pinInput.className = "input comp-pins";
    // Les composants LED adressables prennent « broche, nb LED » ; les autres juste la broche.
    pinInput.placeholder = typeMeta(c.type).extra?.count ? tt("broche, nb LED") : tt("broche");
    pinInput.title = tt(typeMeta(c.type).pinHint || "");
    pinInput.value = c.pins ?? "";
    pinInput.addEventListener("input", () => { c.pins = pinInput.value; regenFirmware(); });

    const del = document.createElement("button");
    del.type = "button"; del.className = "btn-soft comp-del"; del.textContent = "✕";
    del.title = tt("Retirer ce composant");
    del.disabled = fwComps.length <= 1;
    del.addEventListener("click", () => {
      fwComps.splice(idx, 1);
      genId._cur = null; // composition changée -> nouvel objet
      renderCompEditor(); regenFirmware();
    });

    row.append(typeSel, nameInput, pinInput, del);
    host.appendChild(row);
  });
}

function setupFirmware() {
  const boardSel = document.getElementById("fw-board");
  for (const b of BOARDS) { const o = document.createElement("option"); o.value = b.id; o.textContent = b.label; boardSel.appendChild(o); }

  const onBoardChange = () => {
    // L'installation MicroPython (.uf2 par BOOTSEL) ne concerne que le Pico W.
    document.getElementById("fw-uf2-step").hidden = boardSel.value !== "pico";
    // Le flash .bin ESP concerne les cartes ESP32.
    document.getElementById("fw-esp-step").hidden = !["esp32", "esp32s3"].includes(boardSel.value);
    // Réinitialise les broches par défaut des composants pour la nouvelle carte.
    renderCompEditor(); regenFirmware();
  };

  boardSel.addEventListener("change", onBoardChange);
  ["fw-name", "fw-ssid", "fw-pass", "fw-secret"].forEach((id) =>
    document.getElementById(id).addEventListener("input", regenFirmware));
  document.getElementById("fw-add-comp").addEventListener("click", () => {
    fwComps.push({ type: "relay", name: "", pins: typeMeta("relay").pins || "" });
    genId._cur = null;
    renderCompEditor(); regenFirmware();
  });
  document.getElementById("fw-regen").addEventListener("click", () => {
    document.getElementById("fw-secret").value = genKey(); regenFirmware();
  });
  document.getElementById("fw-secret").value = genKey();

  document.getElementById("fw-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(currentFirmware().code); toast("Code copié."); } catch { toast("Copie impossible."); }
  });
  document.getElementById("fw-download").addEventListener("click", () => {
    const fw = currentFirmware();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([fw.code], { type: "text/x-python" }));
    a.download = "main.py"; a.click(); URL.revokeObjectURL(a.href);
  });
  document.getElementById("fw-save").addEventListener("click", saveFirmwareToSandbox);
  document.getElementById("fw-register").addEventListener("click", registerFirmwareDevice);

  setupFlash();
  onBoardChange();
}

// ===== Flash série / installation MicroPython (Pico W + ESP32) =====
function setupFlash() {
  document.getElementById("fw-port-refresh").addEventListener("click", refreshPorts);
  document.getElementById("fw-flash-py").addEventListener("click", flashMainPy);
  document.getElementById("fw-flash-uf2").addEventListener("click", installMicroPython);
  document.getElementById("fw-flash-esp").addEventListener("click", flashEspFirmware);
  // Barre de progression du flash ESP (évènement émis par le backend).
  const evt = __TAURI.event;
  if (evt?.listen) evt.listen("esp-flash-progress", (e) => {
    const bar = document.getElementById("fw-esp-bar");
    if (bar) bar.style.width = `${e.payload || 0}%`;
  });
  refreshPorts();
}

async function flashEspFirmware() {
  const port = document.getElementById("fw-port").value;
  const input = document.getElementById("fw-esp-file");
  const btn = document.getElementById("fw-flash-esp");
  const status = document.getElementById("fw-esp-status");
  const prog = document.getElementById("fw-esp-progress");
  const bar = document.getElementById("fw-esp-bar");
  const file = input.files && input.files[0];
  if (!port) { status.textContent = tt("Sélectionne d'abord un port série (section ci-dessous)."); return; }
  if (!file) { status.textContent = tt("Choisis le fichier .bin de MicroPython (micropython.org ou firmware caméra)."); return; }
  btn.disabled = true; status.textContent = tt("Connexion à l'ESP…");
  prog.hidden = false; bar.style.width = "0%";
  try {
    const b64 = await fileToBase64(file);
    const msg = await invoke("domotique_esp_flash", {
      port, firmwareB64: b64,
      autoReset: document.getElementById("fw-esp-autoreset").checked,
    });
    status.textContent = "✓ " + msg;
  } catch (e) {
    status.textContent = "✗ " + (e.message || e);
  } finally {
    btn.disabled = false;
    setTimeout(() => { prog.hidden = true; }, 1500);
  }
}

async function refreshPorts() {
  const sel = document.getElementById("fw-port");
  const status = document.getElementById("fw-flash-status");
  try {
    const ports = JSON.parse((await invoke("domotique_serial_ports")) || "[]");
    sel.innerHTML = "";
    if (!ports.length) {
      const o = document.createElement("option");
      o.value = ""; o.textContent = tt("Aucun port détecté"); sel.appendChild(o);
      status.textContent = tt("Branchez la carte en USB, puis ⟳.");
      return;
    }
    // Une carte Raspberry Pi détectée est présélectionnée.
    let preferred = "";
    for (const p of ports) {
      const o = document.createElement("option");
      o.value = p.port;
      o.textContent = p.likely_pico ? `${p.label}  ·  Pico ✓` : p.label;
      sel.appendChild(o);
      if (p.likely_pico && !preferred) preferred = p.port;
    }
    if (preferred) sel.value = preferred;
    status.textContent = "";
  } catch (e) {
    status.textContent = tt("Lecture des ports impossible :") + " " + (e.message || e);
  }
}

async function flashMainPy() {
  const port = document.getElementById("fw-port").value;
  const btn = document.getElementById("fw-flash-py");
  const status = document.getElementById("fw-flash-status");
  if (!port) { status.textContent = tt("Sélectionnez d'abord un port série."); return; }
  btn.disabled = true; status.textContent = tt("Téléversement…");
  try {
    const msg = await invoke("domotique_pico_upload", { port, code: currentFirmware().code });
    status.textContent = "✓ " + msg;
    toast("main.py téléversé. Lancez « Découvrir » pour récupérer l'IP.");
  } catch (e) {
    status.textContent = "✗ " + (e.message || e);
  } finally {
    btn.disabled = false;
  }
}

async function installMicroPython() {
  const input = document.getElementById("fw-uf2-file");
  const btn = document.getElementById("fw-flash-uf2");
  const status = document.getElementById("fw-uf2-status");
  const file = input.files && input.files[0];
  if (!file) { status.textContent = tt("Choisissez le fichier .uf2 de MicroPython (micropython.org)."); return; }
  btn.disabled = true; status.textContent = tt("Installation…");
  try {
    const b64 = await fileToBase64(file);
    const msg = await invoke("domotique_pico_flash_uf2", { uf2B64: b64 });
    status.textContent = "✓ " + msg;
  } catch (e) {
    status.textContent = "✗ " + (e.message || e);
  } finally {
    btn.disabled = false;
  }
}

// Lit un fichier en base64 (sans le préfixe data:).
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] || "");
    r.onerror = () => reject(r.error || new Error(tt("Lecture du fichier impossible")));
    r.readAsDataURL(file);
  });
}

function fwOptions() {
  return {
    board: document.getElementById("fw-board").value,
    components: fwComps.map((c) => ({ type: c.type, name: c.name, pins: c.pins })),
    type: fwComps[0]?.type || "relay",   // type « principal » (icône, compat)
    name: document.getElementById("fw-name").value.trim() || "Objet Lumen",
    ssid: document.getElementById("fw-ssid").value,
    password: document.getElementById("fw-pass").value,
    secret: document.getElementById("fw-secret").value.trim(),
    id: genId._cur || (genId._cur = genId()),
  };
}
function currentFirmware() {
  const opts = fwOptions();
  return { filename: "main.py", code: buildFirmware(opts), opts };
}

async function saveFirmwareToSandbox() {
  const fw = currentFirmware();
  try {
    let boxes = await invoke("sandbox_list");
    if (!boxes || !boxes.length) { toast("Aucune sandbox disponible. Créez-en une dans l'explorateur."); return; }
    const id = boxes[0].id;
    const slug = fw.opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const path = `firmwares/${slug || "objet"}-main.py`;
    await invoke("sandbox_write_file", { id, path, content: fw.code });
    toast(tt("Enregistré dans la sandbox « {name} » → {path}", { name: boxes[0].name || id, path }));
  } catch (e) { toast(tt("Échec de l'enregistrement :") + " " + (e.message || e)); }
}

async function registerFirmwareDevice() {
  const opts = fwOptions();
  // Mêmes clés que le firmware généré (normalizeComponents partagé) -> /state et
  // /cmd s'adressent par la même clé côté Lumen et côté carte.
  const components = normalizeComponents(opts).map((c) => ({ key: c.key, type: c.type, name: c.name, pins: c.pins }));
  devices.push({ id: opts.id, name: opts.name, type: opts.type, ip: "", port: 80, secret: opts.secret, room: "", components });
  await saveDevices(); renderDevices();
  genId._cur = null; // prochain firmware = nouvel id
  document.getElementById("fw-secret").value = genKey();
  toast("Objet ajouté. Flashez la carte puis lancez « Découvrir » pour récupérer son IP.");
}

// ===== Mise à jour OTA (Wi-Fi) =====
// Le firmware envoyé garde l'IDENTIFIANT et la CLÉ de l'objet : sans elles, la
// carte redémarrerait avec un secret que Lumen ne connaît pas, injoignable.
function fillOtaDevices() {
  const sel = document.getElementById("fw-ota-device");
  if (!sel) return;
  const keep = sel.value;
  const list = devices.filter((d) => d.ip && d.secret);
  sel.innerHTML = list.length
    ? list.map((d) => `<option value="${d.id}">${d.name} — ${d.ip}</option>`).join("")
    : `<option value="">${tt("Aucun objet joignable (IP et clé requises)")}</option>`;
  if (list.some((d) => d.id === keep)) sel.value = keep;
}
function otaTarget() { return devices.find((d) => d.id === document.getElementById("fw-ota-device").value); }
function loadDeviceIntoForm() {
  const dev = otaTarget();
  if (!dev) return;
  document.getElementById("fw-name").value = dev.name || "";
  document.getElementById("fw-secret").value = dev.secret || "";
  genId._cur = dev.id;
  fwComps = deviceComponents(dev).map((c) => ({ type: c.type, name: c.name || "", pins: c.pins || "" }));
  renderCompEditor(); regenFirmware();
  toast(tt("Configuration chargée : ajustez les composants, le Wi-Fi, puis mettez à jour."));
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function otaUpdate() {
  const dev = otaTarget();
  const status = document.getElementById("fw-ota-status");
  if (!dev) { status.textContent = tt("Choisissez un objet."); return; }
  const opts = { ...fwOptions(), id: dev.id, secret: dev.secret };
  if (!opts.ssid.trim()) { status.textContent = tt("Renseignez le Wi-Fi (SSID et mot de passe) : la carte en aura besoin au redémarrage."); return; }
  if (!(await confirmSheet({ title: tt("Remplacer le firmware de « {n} » par celui du formulaire ?", { n: dev.name }), confirm: tt("Mettre à jour par Wi-Fi"), cancel: tt("Annuler") }))) return;
  const code = buildFirmware(opts);
  status.textContent = tt("Envoi du firmware…");
  try {
    const out = await call(dev, "POST", "/ota", { code, sha256: await sha256Hex(code) });
    const res = JSON.parse(out || "{}");
    if (!res.ok) throw new Error(res.err || out);
    // La composition côté Lumen suit le nouveau firmware.
    dev.name = opts.name || dev.name;
    dev.components = normalizeComponents(opts).map((c) => ({ key: c.key, type: c.type, name: c.name, pins: c.pins }));
    dev.type = opts.type;
    await saveDevices(); renderDevices();
    status.textContent = tt("Mis à jour ({b} octets) : la carte redémarre, elle répond de nouveau dans ~15 s.", { b: res.bytes });
  } catch (e) {
    const msg = String(e?.message || e);
    status.textContent = /404|route inconnue/.test(msg)
      ? tt("Cette carte n'a pas encore de firmware compatible OTA : flashez-la une fois par USB.")
      : `${tt("Échec :")} ${isAuthError(e) ? authHint(dev) : msg}`;
  }
}

// Carte DOM d'un objet (ou un nœud détaché s'il est masqué par le filtre).
function cardOf(dev) {
  return document.querySelector(`#devices-grid .dev-card[data-id="${CSS.escape(dev.id)}"]`) || document.createElement("div");
}

// ===== Divers =====
// Historique des capteurs → CSV dans une sandbox (pour Analyse de données…).
async function saveHistoryCsv() {
  try {
    const list = await invoke("sandbox_list");
    const sb = list?.[0];
    if (!sb) { toast("Créez d'abord une sandbox dans Fichiers."); return; }
    const name = `domotique-historique-${new Date().toISOString().slice(0, 10)}.csv`;
    await invoke("sandbox_write_file", { id: sb.id, path: name, content: historyCsv() });
    toast(`${tt("Exporté")} : ${sb.name || sb.id} › ${name}`);
  } catch (e) { toast(tt("Échec :") + " " + (e?.message || e)); }
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = tt(msg); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3200);
}

// ===== Démarrage =====
async function init() {
  translatePage();
  observeTranslations();
  setupTabs();
  setupFirmware();
  document.getElementById("btn-scan").addEventListener("click", scan);
  document.getElementById("btn-add").addEventListener("click", () => openDeviceModal(null));
  document.getElementById("dev-cancel").addEventListener("click", closeDeviceModal);
  document.getElementById("dev-save").addEventListener("click", saveDeviceModal);
  document.getElementById("dev-delete").addEventListener("click", deleteDevice);
  await loadDevices();
  await initHome({
    devices: () => devices, call, deviceComponents, typeMeta, tt, toast,
    onChange: () => renderDevices(),
    notify: (title, body) => invoke?.("notify_island", { payload: { kind: "warn", title, body, icon: "house", source: "domotique" } })?.catch?.(() => {}),
  });
  await initPlan({
    devices: () => devices, deviceComponents, typeMeta, tt, toast,
    act: (dev, comp, payload) => act(dev, comp, payload, cardOf(dev)),
    refresh: (dev) => refreshDevice(dev, cardOf(dev)),
    openDevice: (dev) => {
      document.querySelector('.tab[data-tab="devices"]')?.click();
      const card = cardOf(dev);
      card.scrollIntoView?.({ behavior: "smooth", block: "center" });
      card.classList?.add("flash"); setTimeout(() => card.classList?.remove("flash"), 1600);
    },
  });
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    if (t.dataset.tab === "plan") renderPlan(document.getElementById("plan-host"));
    if (t.dataset.tab === "scenes") renderScenes(document.getElementById("scenes-host"));
    if (t.dataset.tab === "rules") renderRules(document.getElementById("rules-host"));
  }));
  document.getElementById("btn-hist-csv").addEventListener("click", saveHistoryCsv);
  fillOtaDevices();
  document.getElementById("fw-ota-load")?.addEventListener("click", loadDeviceIntoForm);
  document.getElementById("fw-ota-send")?.addEventListener("click", otaUpdate);
  document.querySelector('.tab[data-tab="firmware"]')?.addEventListener("click", fillOtaDevices);
  // App Intents (manifeste) : l'assistant lance une scène même depuis la discussion.
  const intents = window.lumen?.intents;
  if (intents) {
    intents.on("run_scene", async ({ scene }) => runScene(scene)).catch(() => {});
    intents.on("list_scenes", async () => runDomoTool("list_scenes", {})).catch(() => {});
  }
  renderDevices();
  mountDomoAI();
  startPolling();
}
init();
