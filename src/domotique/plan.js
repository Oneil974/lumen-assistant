// Domotique — plan de la maison en vue « tableau de bord ».
//
// Un plan = une image de fond facultative (photo ou dessin du plan, importée)
// + des pièces dessinées (rectangles nommés, déplaçables et redimensionnables)
// + les objets posés dessus. Chaque pastille affiche l'état en direct (mesure
// principale, allumé/éteint, alerte) ; un clic bascule un actionneur, un clic
// sur un capteur ouvre sa carte. Un bandeau résume la maison : alertes (fuite,
// CO₂, porte ouverte, sonnette), températures, objets hors ligne.
//
// Positions en % du plan : le tableau reste juste quelle que soit la taille de
// la fenêtre. Stockage : magasin « domotique », clé `plan`.

import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { createStore } from "../lib/app-state.js";

const store = createStore("domotique");
const live = new Map(); // devId → { online, st }
let ctx = null;          // { devices(), deviceComponents, typeMeta, tt, toast, act(dev, comp, payload), openDevice(dev) }
let plan = { image: "", rooms: [], pins: {} };
let editing = false;
let host = null;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const uid = () => `room-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const save = () => store.set("plan", plan);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export async function initPlan(context) {
  ctx = context;
  await store.ready();
  plan = { image: "", rooms: [], pins: {}, ...(store.getJSON("plan", {}) || {}) };
}

/** Appelé à chaque lecture d'état d'un objet (main.js › refreshDevice). */
export function notePlanState(dev, online, st) {
  live.set(dev.id, { online, st: st || {} });
  if (host && !editing && host.isConnected) paintPins();
}

const subState = (dev, comp) => {
  const st = live.get(dev.id)?.st || {};
  return comp.key == null ? st : (st[comp.key] || {});
};

/** Mesure principale + niveau d'alerte d'un composant. */
function summary(dev, comp) {
  const s = subState(dev, comp);
  const t = comp.type;
  if (s.err) return { text: "!", alert: "warn" };
  switch (t) {
    case "temperature": return { text: s.temp != null ? `${s.temp}°` : "—" };
    case "thermostat": return { text: s.temp != null ? `${s.temp}° → ${s.setpoint}°` : "—", on: !!s.heating };
    case "co2": return { text: s.co2 != null ? `${s.co2} ppm` : "—", alert: s.co2 >= 1200 ? "bad" : s.co2 >= 800 ? "warn" : "" };
    case "particles": return { text: s.pm25 != null ? `PM2.5 ${s.pm25}` : "—", alert: s.pm25 > 35 ? "bad" : s.pm25 > 15 ? "warn" : "" };
    case "water_leak": return { text: s.leak ? ctx.tt("Fuite !") : "OK", alert: s.leak ? "bad" : "" };
    case "doorbell": return { text: s.ring ? ctx.tt("On sonne !") : "🔔", alert: s.ring ? "warn" : "" };
    case "contact": return { text: s.open ? ctx.tt("Ouvert") : ctx.tt("Fermé"), alert: s.open ? "warn" : "" };
    case "presence": return { text: s.motion ? ctx.tt("Présence") : "—", on: !!s.motion };
    case "light_sensor": return { text: s.level != null ? `${s.level} %` : "—" };
    case "servo": return { text: s.angle != null ? `${s.angle}°` : "—" };
    default: return { text: s.on ? ctx.tt("Allumé") : ctx.tt("Éteint"), on: !!s.on };
  }
}

// ------------------------------------------------------------------ Rendu
export function renderPlan(el) {
  host = el;
  const { tt } = ctx;
  el.innerHTML = `<div class="plan-dash"></div>
    <div class="plan-toolbar">
      <button type="button" class="btn-soft${editing ? " primary" : ""}" data-p="edit">${esc(tt(editing ? "Terminer l'édition" : "Modifier le plan"))}</button>
      ${editing ? `<button type="button" class="btn-soft" data-p="room">${esc(tt("＋ Pièce"))}</button>
        <button type="button" class="btn-soft" data-p="auto">${esc(tt("Disposition automatique"))}</button>
        <label class="btn-soft plan-file">${esc(tt("Image du plan…"))}<input type="file" accept="image/*" hidden></label>
        ${plan.image ? `<button type="button" class="btn-soft" data-p="noimg">${esc(tt("Retirer l'image"))}</button>` : ""}
        <span class="muted">${esc(tt("Glissez les pièces et les objets ; coin bas-droit pour redimensionner ; double-clic pour renommer une pièce."))}</span>` : ""}
    </div>
    <div class="plan-wrap"><div class="plan${editing ? " editing" : ""}"${plan.image ? ` style="background-image:url('${plan.image}')"` : ""}>
      ${plan.rooms.map((r) => `<div class="plan-room" data-room="${r.id}" style="left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%">
          <span class="plan-room-name">${esc(r.name)}</span>${editing ? `<button type="button" class="plan-room-del" title="${esc(tt("Supprimer"))}">✕</button><span class="plan-resize"></span>` : ""}</div>`).join("")}
      <div class="plan-pins"></div>
    </div></div>
    <div class="plan-tray"${editing ? "" : " hidden"}><b>${esc(tt("À placer :"))}</b> <span class="plan-tray-list"></span></div>`;
  wire(el);
  paintPins();
}

function placed() {
  const out = [];
  for (const d of ctx.devices()) for (const c of ctx.deviceComponents(d)) {
    const k = `${d.id}|${c.key ?? ""}`;
    if (plan.pins[k]) out.push({ d, c, k, pos: plan.pins[k] });
  }
  return out;
}

function paintPins() {
  if (!host) return;
  const { tt } = ctx;
  const pins = host.querySelector(".plan-pins");
  if (!pins) return;
  pins.innerHTML = placed().map(({ d, c, k, pos }) => {
    const meta = ctx.typeMeta(c.type);
    const sm = summary(d, c);
    const online = live.get(d.id)?.online;
    const label = ctx.deviceComponents(d).length > 1 ? `${d.name} · ${c.name || c.key}` : d.name;
    return `<button type="button" class="plan-pin${sm.on ? " on" : ""}${sm.alert ? ` alert-${sm.alert}` : ""}${online === false ? " offline" : ""}" data-pin="${esc(k)}"
        style="left:${pos.x}%;top:${pos.y}%;--pin:${meta.color}" title="${esc(label)}">
        <span class="plan-pin-ic"><svg viewBox="0 0 24 24">${meta.icon}</svg></span>
        <span class="plan-pin-txt"><small>${esc(label)}</small><b>${esc(online === false ? tt("Hors ligne") : sm.text)}</b></span></button>`;
  }).join("");
  // Bac des objets non placés (mode édition).
  const tray = host.querySelector(".plan-tray-list");
  if (tray) {
    const rest = [];
    for (const d of ctx.devices()) for (const c of ctx.deviceComponents(d)) {
      const k = `${d.id}|${c.key ?? ""}`;
      if (!plan.pins[k]) rest.push(`<button type="button" class="chip" data-add="${esc(k)}">${esc(ctx.deviceComponents(d).length > 1 ? `${d.name} · ${c.name || c.key}` : d.name)}</button>`);
    }
    tray.innerHTML = rest.join(" ") || `<span class="muted">${esc(tt("Tous les objets sont placés."))}</span>`;
  }
  paintDash();
}

function paintDash() {
  const { tt } = ctx;
  const dash = host?.querySelector(".plan-dash");
  if (!dash) return;
  const alerts = [], temps = [];
  let offline = 0, onCount = 0;
  for (const d of ctx.devices()) {
    const l = live.get(d.id);
    if (l && !l.online) offline++;
    for (const c of ctx.deviceComponents(d)) {
      const s = subState(d, c);
      const where = d.room ? ` (${d.room})` : "";
      if (c.type === "water_leak" && s.leak) alerts.push(`💧 ${tt("Fuite d'eau")} — ${d.name}${where}`);
      if (c.type === "co2" && s.co2 >= 1200) alerts.push(`🌫️ CO₂ ${s.co2} ppm — ${tt("aérez")}${where}`);
      if (c.type === "particles" && s.pm25 > 35) alerts.push(`🌫️ PM2.5 ${s.pm25} µg/m³${where}`);
      if (c.type === "contact" && s.open) alerts.push(`🚪 ${tt("Ouvert")} — ${d.name}${where}`);
      if (c.type === "doorbell" && s.ring) alerts.push(`🔔 ${tt("On sonne à la porte")}`);
      if ((c.type === "temperature" || c.type === "thermostat" || c.type === "co2") && typeof s.temp === "number") temps.push(s.temp);
      if (s.on === true || s.heating === true) onCount++;
    }
  }
  const avg = temps.length ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : null;
  dash.innerHTML = `
    <div class="dash-tile${alerts.length ? " bad" : ""}"><b>${alerts.length}</b><span>${esc(tt(alerts.length > 1 ? "alertes" : "alerte"))}</span></div>
    <div class="dash-tile"><b>${avg != null ? `${avg} °C` : "—"}</b><span>${esc(tt("température moyenne"))}</span></div>
    <div class="dash-tile"><b>${onCount}</b><span>${esc(tt("allumé(s) / en chauffe"))}</span></div>
    <div class="dash-tile${offline ? " warn" : ""}"><b>${offline}</b><span>${esc(tt("hors ligne"))}</span></div>
    ${alerts.length ? `<ul class="dash-alerts">${alerts.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}`;
}

// ------------------------------------------------------------------ Interactions
function pct(planEl, e) {
  const r = planEl.getBoundingClientRect();
  return { x: clamp(((e.clientX - r.left) / r.width) * 100, 0, 100), y: clamp(((e.clientY - r.top) / r.height) * 100, 0, 100) };
}

function wire(el) {
  const { tt } = ctx;
  const planEl = el.querySelector(".plan");
  el.querySelector(".plan-toolbar").onclick = (e) => {
    const b = e.target.closest("[data-p]"); if (!b) return;
    if (b.dataset.p === "edit") { editing = !editing; renderPlan(el); }
    else if (b.dataset.p === "room") {
      plan.rooms.push({ id: uid(), name: tt("Pièce"), x: 10 + Math.random() * 40, y: 10 + Math.random() * 40, w: 25, h: 22 });
      save(); renderPlan(el);
    } else if (b.dataset.p === "auto") {
      // Une pièce par pièce déclarée sur les objets, en grille, objets dedans.
      const names = [...new Set(ctx.devices().map((d) => (d.room || "").trim()).filter(Boolean))];
      if (!names.length) names.push(tt("Maison"));
      const cols = Math.ceil(Math.sqrt(names.length)), rows = Math.ceil(names.length / cols);
      const w = 96 / cols, h = 94 / rows;
      plan.rooms = names.map((name, i) => ({ id: uid(), name, x: 2 + (i % cols) * w, y: 3 + Math.floor(i / cols) * h, w: w - 2, h: h - 3 }));
      plan.pins = {};
      const count = {};
      for (const d of ctx.devices()) for (const c of ctx.deviceComponents(d)) {
        const r = plan.rooms.find((x) => x.name === (d.room || "").trim()) || plan.rooms[0];
        const k = count[r.id] = (count[r.id] || 0) + 1;
        plan.pins[`${d.id}|${c.key ?? ""}`] = { x: r.x + r.w * (0.25 + 0.5 * (((k - 1) % 2))), y: r.y + r.h * (0.3 + 0.22 * Math.floor((k - 1) / 2)) };
      }
      save(); renderPlan(el);
    } else if (b.dataset.p === "noimg") { plan.image = ""; save(); renderPlan(el); }
  };
  el.querySelector(".plan-file input")?.addEventListener("change", (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    // Image redimensionnée (≤ 1600 px) avant stockage : le plan reste léger.
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      plan.image = c.toDataURL("image/jpeg", 0.85); save(); renderPlan(el);
    };
    img.src = URL.createObjectURL(f);
  });
  el.querySelector(".plan-tray")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-add]"); if (!b) return;
    // Dans la pièce du même nom si elle est dessinée, sinon en quinconce.
    const [id] = b.dataset.add.split("|");
    const dev = ctx.devices().find((d) => d.id === id);
    const room = plan.rooms.find((r) => r.name.trim().toLowerCase() === String(dev?.room || "").trim().toLowerCase());
    const n = Object.keys(plan.pins).length;
    plan.pins[b.dataset.add] = room
      ? { x: room.x + room.w * (0.3 + 0.4 * ((n % 3) / 2)), y: room.y + room.h * (0.35 + 0.3 * ((n >> 1) % 2)) }
      : { x: 12 + (n % 6) * 15, y: 15 + Math.floor(n / 6) * 14 };
    save(); paintPins();
  });

  // Glisser-déposer (pièces, poignée de taille, pastilles) en mode édition.
  let drag = null;
  planEl.addEventListener("pointerdown", (e) => {
    if (!editing) return;
    const del = e.target.closest(".plan-room-del");
    if (del) {
      const id = del.closest("[data-room]").dataset.room;
      plan.rooms = plan.rooms.filter((r) => r.id !== id); save(); renderPlan(el); return;
    }
    const pin = e.target.closest("[data-pin]");
    const room = e.target.closest("[data-room]");
    const p0 = pct(planEl, e);
    if (pin) drag = { kind: "pin", key: pin.dataset.pin, node: pin, p0, start: { ...plan.pins[pin.dataset.pin] } };
    else if (room) {
      const r = plan.rooms.find((x) => x.id === room.dataset.room);
      drag = { kind: e.target.classList.contains("plan-resize") ? "size" : "room", r, node: room, p0, start: { ...r } };
    }
    if (drag) { e.preventDefault(); planEl.setPointerCapture(e.pointerId); }
  });
  planEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = pct(planEl, e), dx = p.x - drag.p0.x, dy = p.y - drag.p0.y;
    if (drag.kind === "pin") {
      const pos = plan.pins[drag.key] = { x: clamp(drag.start.x + dx, 0, 100), y: clamp(drag.start.y + dy, 0, 100) };
      drag.node.style.left = `${pos.x}%`; drag.node.style.top = `${pos.y}%`;
    } else if (drag.kind === "room") {
      drag.r.x = clamp(drag.start.x + dx, 0, 100 - drag.r.w); drag.r.y = clamp(drag.start.y + dy, 0, 100 - drag.r.h);
      drag.node.style.left = `${drag.r.x}%`; drag.node.style.top = `${drag.r.y}%`;
    } else {
      drag.r.w = clamp(drag.start.w + dx, 6, 100 - drag.r.x); drag.r.h = clamp(drag.start.h + dy, 6, 100 - drag.r.y);
      drag.node.style.width = `${drag.r.w}%`; drag.node.style.height = `${drag.r.h}%`;
    }
  });
  planEl.addEventListener("pointerup", () => { if (drag) { save(); drag = null; } });
  planEl.addEventListener("dblclick", async (e) => {
    if (!editing) return;
    const room = e.target.closest("[data-room]"); if (!room) return;
    const r = plan.rooms.find((x) => x.id === room.dataset.room);
    const name = await promptSheet({ title: tt("Nom de la pièce"), value: r.name, confirm: tt("Valider"), cancel: tt("Annuler") });
    if (name) { r.name = name.trim(); save(); renderPlan(el); }
  });
  // Hors édition : un clic bascule un actionneur, ou ouvre la carte d'un capteur.
  planEl.addEventListener("click", async (e) => {
    if (editing) return;
    const pin = e.target.closest("[data-pin]"); if (!pin) return;
    const [id, key] = pin.dataset.pin.split("|");
    const dev = ctx.devices().find((d) => d.id === id); if (!dev) return;
    const comp = ctx.deviceComponents(dev).find((c) => (c.key ?? "") === key) || ctx.deviceComponents(dev)[0];
    const meta = ctx.typeMeta(comp.type);
    if (meta.kind === "actuator" && comp.type !== "servo") {
      const s = subState(dev, comp);
      const params = comp.type === "thermostat" ? { mode: s.mode === "heat" ? "off" : "heat" } : { on: !s.on };
      await ctx.act(dev, comp, { action: "set", params });
      ctx.refresh?.(dev);
    } else ctx.openDevice?.(dev);
  });
}
