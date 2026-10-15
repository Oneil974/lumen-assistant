// Domotique — la maison au-dessus des objets : pièces, scènes enregistrées,
// automatisations (seuils de capteurs, horaires, alertes) et historique des
// mesures. Rien ne change dans le protocole LLD : tout passe par les mêmes
// /state et /cmd que les cartes.
//
// Stockage : magasin d'app « domotique » (lib/app-state.js), à part de
// domotique.json — ce dernier reste la liste d'objets lue par le backend Rust
// (outils de l'assistant), dont on ne change pas le format.
//
// Les automatisations s'évaluent tant que l'app est ouverte (vue de la coque
// ou fenêtre du bureau) : c'est dit dans l'interface, sans laisser croire à un
// démon qui tournerait app fermée.

import { confirmSheet, promptSheet } from "../lib/confirm.js";
import { createStore } from "../lib/app-state.js";

const store = createStore("domotique");
const HIST_MAX_AGE = 24 * 3600 * 1000;
const HIST_MAX_POINTS = 720; // ~1 point / 2 min sur 24 h
let ctx = null;              // { devices(), call, deviceComponents, typeMeta, tt, toast, onChange }

const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const load = (k, d) => { const v = store.getJSON(k, d); return v ?? d; };

export const home = {
  scenes: [], rules: [], history: {}, room: "",
};

export async function initHome(context) {
  ctx = context;
  await store.ready();
  home.scenes = load("scenes", []);
  home.rules = load("rules", []);
  home.history = load("history", {});
  home.room = load("room", "") || "";
  setInterval(tickTimeRules, 30_000);
}
const saveScenes = () => store.set("scenes", home.scenes);
const saveRules = () => store.set("rules", home.rules);
let histTimer = null;
const saveHistory = () => { clearTimeout(histTimer); histTimer = setTimeout(() => store.set("history", home.history), 4000); };

// ---------------------------------------------------------------- Pièces
export function rooms() {
  return [...new Set(ctx.devices().map((d) => (d.room || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
export function inRoom(dev) { return !home.room || (dev.room || "").trim() === home.room; }

/** Barre de filtres par pièce + actions groupées (tout allumer / éteindre). */
export function renderRoomBar(host) {
  const { tt } = ctx;
  const list = rooms();
  if (!list.length) { host.hidden = true; return; }
  host.hidden = false;
  if (home.room && !list.includes(home.room)) home.room = "";
  host.innerHTML = `<div class="room-chips">
      <button type="button" class="chip${home.room ? "" : " on"}" data-room="">${esc(tt("Toutes les pièces"))}</button>
      ${list.map((r) => `<button type="button" class="chip${home.room === r ? " on" : ""}" data-room="${esc(r)}">${esc(r)}</button>`).join("")}
    </div>
    <span class="spacer"></span>
    <button type="button" class="btn-soft" data-all="on">${esc(tt(home.room ? "Tout allumer ici" : "Tout allumer"))}</button>
    <button type="button" class="btn-soft" data-all="off">${esc(tt(home.room ? "Tout éteindre ici" : "Tout éteindre"))}</button>`;
  host.onclick = async (e) => {
    const chip = e.target.closest("[data-room]");
    if (chip) { home.room = chip.dataset.room; store.set("room", home.room); ctx.onChange(); return; }
    const all = e.target.closest("[data-all]");
    if (all) {
      const on = all.dataset.all === "on";
      const steps = [];
      for (const d of ctx.devices().filter(inRoom)) {
        for (const c of ctx.deviceComponents(d)) {
          if (["relay", "dimmer", "rgb", "matrix8"].includes(c.type)) steps.push({ device: d.id, component: c.key, action: "set", params: { on } });
        }
      }
      const res = await runSteps(steps);
      ctx.toast(`${tt(on ? "Allumé" : "Éteint")} : ${res.ok}/${steps.length}`);
    }
  };
}

// ---------------------------------------------------------------- Commandes
async function runStep(s) {
  const dev = ctx.devices().find((d) => d.id === s.device);
  if (!dev) throw new Error("objet introuvable");
  const body = { action: s.action || "set", params: s.params || {} };
  if (s.component != null) body.component = s.component;
  return ctx.call(dev, "POST", "/cmd", body);
}
async function runSteps(steps) {
  const out = await Promise.allSettled(steps.map(runStep));
  return { ok: out.filter((r) => r.status === "fulfilled").length, errors: out.filter((r) => r.status === "rejected").map((r) => r.reason?.message || String(r.reason)) };
}

// ---------------------------------------------------------------- Scènes
export function sceneByRef(ref) {
  const r = String(ref || "").trim().toLowerCase();
  return home.scenes.find((s) => s.id === ref) || home.scenes.find((s) => s.name.toLowerCase() === r) || home.scenes.find((s) => s.name.toLowerCase().includes(r));
}
export async function runScene(ref) {
  const sc = typeof ref === "object" ? ref : sceneByRef(ref);
  if (!sc) throw new Error(`aucune scène « ${ref} »`);
  const res = await runSteps(sc.steps || []);
  return `${sc.name} : ${res.ok}/${(sc.steps || []).length} ${ctx.tt("commande(s) passée(s)")}${res.errors.length ? ` — ${res.errors.join(" ; ")}` : ""}`;
}

/** Photographie l'état des actionneurs en une scène (allumé/éteint, intensité, couleur, angle). */
async function captureScene(name) {
  const steps = [];
  for (const d of ctx.devices().filter(inRoom)) {
    let st; try { st = JSON.parse(await ctx.call(d, "GET", "/state")); } catch { continue; }
    for (const c of ctx.deviceComponents(d)) {
      const meta = ctx.typeMeta(c.type);
      if (meta.kind === "sensor") continue;
      const sub = c.key == null ? st : (st[c.key] || {});
      const params = {};
      for (const k of ["on", "brightness", "r", "g", "b", "angle", "setpoint", "mode"]) if (sub[k] != null) params[k] = sub[k];
      if (Object.keys(params).length) steps.push({ device: d.id, component: c.key, action: "set", params });
    }
  }
  const sc = { id: uid("scene"), name, steps };
  home.scenes.push(sc); saveScenes();
  return sc;
}

const ACTIONS = [
  ["on", "Allumer", { on: true }], ["off", "Éteindre", { on: false }],
  ["dim", "Intensité (%)", null], ["color", "Couleur", null], ["angle", "Angle (°)", null],
];
function stepToForm(s) {
  const p = s.params || {};
  if (p.angle != null) return ["angle", p.angle];
  if (p.r != null) return ["color", "#" + [p.r, p.g, p.b].map((x) => Number(x || 0).toString(16).padStart(2, "0")).join("")];
  if (p.brightness != null) return ["dim", p.brightness];
  return [p.on === false ? "off" : "on", ""];
}
function formToParams(kind, val) {
  if (kind === "on") return { on: true };
  if (kind === "off") return { on: false };
  if (kind === "dim") return { on: true, brightness: Math.max(0, Math.min(100, Number(val) || 0)) };
  if (kind === "angle") return { angle: Math.max(0, Math.min(180, Number(val) || 0)) };
  const n = parseInt(String(val || "#ffffff").slice(1), 16) || 0;
  return { on: true, r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function componentOptions(selected) {
  const out = [];
  for (const d of ctx.devices()) for (const c of ctx.deviceComponents(d)) {
    if (ctx.typeMeta(c.type).kind === "sensor") continue;
    const v = `${d.id}|${c.key ?? ""}`;
    const label = ctx.deviceComponents(d).length > 1 ? `${d.name} › ${c.name || c.key}` : d.name;
    out.push(`<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(label)}</option>`);
  }
  return out.join("");
}

export function renderScenes(host) {
  const { tt } = ctx;
  host.innerHTML = `<div class="home-head"><div><h3>${esc(tt("Scènes"))}</h3>
      <p class="muted">${esc(tt("Plusieurs commandes d'un coup : « Soirée », « Je pars », « Réveil ». L'assistant peut aussi les lancer par leur nom."))}</p></div>
      <span class="spacer"></span>
      <button type="button" class="btn-soft" data-act="capture">${esc(tt("Capturer l'état actuel"))}</button>
      <button type="button" class="btn-soft primary" data-act="new">${esc(tt("＋ Nouvelle scène"))}</button></div>
    <div class="scene-grid">${home.scenes.map((s) => `<div class="scene-card" data-id="${s.id}">
      <div class="scene-name">${esc(s.name)}</div><div class="muted">${(s.steps || []).length} ${esc(tt("commande(s)"))}</div>
      <div class="scene-actions"><button type="button" class="btn-soft primary" data-act="run">${esc(tt("Lancer"))}</button>
      <button type="button" class="btn-soft" data-act="edit">${esc(tt("Modifier"))}</button></div></div>`).join("")
      || `<div class="empty"><p>${esc(tt("Aucune scène pour l'instant."))}</p></div>`}</div>
    <div class="scene-editor" hidden></div>`;
  host.onclick = async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const card = b.closest(".scene-card");
    const sc = card && home.scenes.find((s) => s.id === card.dataset.id);
    if (b.dataset.act === "run" && sc) ctx.toast(await runScene(sc));
    else if (b.dataset.act === "edit" && sc) editScene(host, sc);
    else if (b.dataset.act === "new") editScene(host, { id: uid("scene"), name: "", steps: [], fresh: true });
    else if (b.dataset.act === "capture") {
      const name = await promptSheet({ title: tt("Nom de la scène"), value: home.room ? `${home.room} — ${tt("ambiance")}` : tt("Ambiance"), confirm: tt("Valider"), cancel: tt("Annuler") });
      if (!name) return;
      const s = await captureScene(name);
      ctx.toast(`${tt("Scène créée")} : ${s.steps.length} ${tt("commande(s)")}`);
      renderScenes(host);
    }
  };
}

function editScene(host, sc) {
  const { tt } = ctx;
  const ed = host.querySelector(".scene-editor");
  ed.hidden = false;
  const stepRow = (s) => {
    const [kind, val] = stepToForm(s);
    return `<div class="step-row">
      <select class="select st-target">${componentOptions(`${s.device}|${s.component ?? ""}`)}</select>
      <select class="select st-kind">${ACTIONS.map(([k, l]) => `<option value="${k}"${k === kind ? " selected" : ""}>${esc(tt(l))}</option>`).join("")}</select>
      <input class="input st-val" value="${esc(val)}" placeholder="${esc(tt("valeur"))}" />
      <button type="button" class="btn-soft danger st-del" title="${esc(tt("Retirer"))}">✕</button></div>`;
  };
  ed.innerHTML = `<h3>${esc(tt(sc.fresh ? "Nouvelle scène" : "Modifier la scène"))}</h3>
    <label class="fld">${esc(tt("Nom"))}<input class="input sc-name" value="${esc(sc.name)}" placeholder="${esc(tt("Ex. : Soirée cinéma"))}" /></label>
    <div class="steps">${(sc.steps || []).map(stepRow).join("")}</div>
    <div class="editor-actions"><button type="button" class="btn-soft sc-add">${esc(tt("＋ Ajouter une commande"))}</button>
      <span class="spacer"></span>
      ${sc.fresh ? "" : `<button type="button" class="btn-soft danger sc-delete">${esc(tt("Supprimer"))}</button>`}
      <button type="button" class="btn-soft sc-cancel">${esc(tt("Annuler"))}</button>
      <button type="button" class="btn-soft primary sc-save">${esc(tt("Enregistrer"))}</button></div>`;
  const stepsEl = ed.querySelector(".steps");
  const firstTarget = () => { const d = ctx.devices()[0]; const c = d && ctx.deviceComponents(d)[0]; return { device: d?.id, component: c?.key ?? null }; };
  ed.querySelector(".sc-add").onclick = () => stepsEl.insertAdjacentHTML("beforeend", stepRow({ ...firstTarget(), params: { on: true } }));
  stepsEl.onclick = (e) => { if (e.target.closest(".st-del")) e.target.closest(".step-row").remove(); };
  ed.querySelector(".sc-cancel").onclick = () => { ed.hidden = true; };
  ed.querySelector(".sc-delete")?.addEventListener("click", async () => {
    if (!(await confirmSheet({ title: tt("Supprimer cette scène ?"), confirm: tt("Supprimer"), cancel: tt("Annuler"), danger: true }))) return;
    home.scenes = home.scenes.filter((s) => s.id !== sc.id); saveScenes(); renderScenes(host);
  });
  ed.querySelector(".sc-save").onclick = () => {
    const name = ed.querySelector(".sc-name").value.trim();
    if (!name) { ctx.toast(tt("Donnez un nom à la scène.")); return; }
    const steps = [...stepsEl.querySelectorAll(".step-row")].map((row) => {
      const [device, comp] = row.querySelector(".st-target").value.split("|");
      return { device, component: comp === "" ? null : comp, action: "set", params: formToParams(row.querySelector(".st-kind").value, row.querySelector(".st-val").value) };
    });
    const next = { id: sc.id, name, steps };
    const i = home.scenes.findIndex((s) => s.id === sc.id);
    if (i >= 0) home.scenes[i] = next; else home.scenes.push(next);
    saveScenes(); renderScenes(host);
  };
}

// ---------------------------------------------------------------- Historique
// Champs numériques lus par type ; les booléens (présence, contact) sont
// gardés en 0/1 pour la frise et pour les règles.
const FIELDS = { temperature: ["temp", "hum"], light_sensor: ["level"], presence: ["motion"], contact: ["open"],
  co2: ["co2", "temp", "hum"], particles: ["pm25", "pm10"], water_leak: ["leak"], doorbell: ["ring"], thermostat: ["temp", "setpoint", "heating"] };
const FIELD_LABEL = { temp: "Température", hum: "Humidité", level: "Luminosité", motion: "Présence", open: "Ouverture",
  co2: "CO₂", pm25: "PM2.5", pm10: "PM10", leak: "Fuite d'eau", ring: "Sonnette", setpoint: "Consigne", heating: "Chauffe" };
const hkey = (dev, comp, f) => `${dev.id}|${comp.key ?? ""}|${f}`;

export function sensorFields(type) { return FIELDS[type] || []; }

/** Appelé à chaque lecture d'un capteur : historise et évalue les règles. */
export function recordReading(dev, comp, st) {
  const now = Date.now();
  for (const f of FIELDS[comp.type] || []) {
    const raw = st?.[f];
    if (raw == null) continue;
    const v = typeof raw === "boolean" ? (raw ? 1 : 0) : Number(raw);
    if (!Number.isFinite(v)) continue;
    const k = hkey(dev, comp, f);
    const arr = home.history[k] || (home.history[k] = []);
    // Un point toutes les 2 min au plus, sauf changement d'un booléen.
    const last = arr[arr.length - 1];
    if (!last || now - last[0] > 115_000 || (typeof raw === "boolean" && last[1] !== v)) {
      arr.push([now, v]);
      while (arr.length && (arr.length > HIST_MAX_POINTS || now - arr[0][0] > HIST_MAX_AGE)) arr.shift();
      saveHistory();
    }
    evaluateSensorRules(dev, comp, f, v);
  }
}

/** Mini-courbe SVG des dernières 24 h d'un champ. */
export function sparkline(dev, comp, f) {
  const arr = home.history[hkey(dev, comp, f)] || [];
  if (arr.length < 2) return "";
  const xs = arr.map((p) => p[0]), ys = arr.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const W = 120, H = 28, sx = (x) => ((x - x0) / Math.max(1, x1 - x0)) * W, sy = (y) => H - 2 - ((y - y0) / Math.max(1e-9, y1 - y0)) * (H - 4);
  const d = arr.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
  const tip = `${ctx.tt(FIELD_LABEL[f] || f)} · min ${y0} · max ${y1} (24 h)`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(tip)}"><title>${esc(tip)}</title><path d="${d}"/></svg>`;
}

/** Export CSV de tout l'historique (pour Analyse de données, tableur…). */
export function historyCsv() {
  const rows = ["date;objet;composant;mesure;valeur"];
  for (const [k, arr] of Object.entries(home.history)) {
    const [id, comp, f] = k.split("|");
    const dev = ctx.devices().find((d) => d.id === id);
    for (const [t, v] of arr) rows.push(`${new Date(t).toISOString()};${dev?.name || id};${comp};${f};${v}`);
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------- Automatisations
const OPS = { ">": (a, b) => a > b, "<": (a, b) => a < b, "=": (a, b) => a === b };
const ruleState = new Map(); // id → dernier résultat de la condition (déclenchement sur front montant)

async function fire(rule, why) {
  const last = rule.lastFired || 0;
  if (Date.now() - last < (Number(rule.cooldownMin) || 0) * 60_000) return;
  rule.lastFired = Date.now(); saveRules();
  let result = "";
  try {
    if (rule.then?.scene) result = await runScene(rule.then.scene);
    else if (rule.then?.device) { await runStep(rule.then); result = ctx.tt("commande envoyée"); }
  } catch (e) { result = `${ctx.tt("échec")} : ${e?.message || e}`; }
  // Mémoire épisodique : ce que la maison a fait (lisible par l'assistant).
  try {
    const inv = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;
    inv?.("mem_remember", { context: "domotique", kind: "episodic", text: `Domotique — règle « ${rule.name} » : ${[why, result].filter(Boolean).join(" — ")}`, tags: ["domotique"], source: "Domotique" })?.catch?.(() => {});
  } catch {}
  if (rule.notify) {
    ctx.notify?.(rule.name, [why, result].filter(Boolean).join(" — "));
  }
  ctx.onRuleFired?.(rule, why, result);
}

function evaluateSensorRules(dev, comp, f, v) {
  for (const r of home.rules) {
    if (!r.enabled || r.when?.kind !== "sensor") continue;
    const w = r.when;
    if (w.device !== dev.id || (w.component ?? "") !== (comp.key ?? "") || w.field !== f) continue;
    const ok = (OPS[w.op] || OPS[">"])(v, Number(w.value));
    const prev = ruleState.get(r.id);
    ruleState.set(r.id, ok);
    if (ok && prev === false) fire(r, `${dev.name} · ${ctx.tt(FIELD_LABEL[f] || f)} ${w.op} ${w.value} (${v})`);
  }
}

function tickTimeRules() {
  const now = new Date();
  const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const today = now.toDateString();
  for (const r of home.rules) {
    if (!r.enabled || r.when?.kind !== "time") continue;
    const days = r.when.days?.length ? r.when.days : [0, 1, 2, 3, 4, 5, 6];
    if (r.when.at !== hm || !days.includes(now.getDay()) || r.lastDay === today) continue;
    r.lastDay = today;
    fire(r, `${ctx.tt("Il est")} ${hm}`);
  }
}

function sensorOptions(selected) {
  const out = [];
  for (const d of ctx.devices()) for (const c of ctx.deviceComponents(d)) for (const f of FIELDS[c.type] || []) {
    const v = `${d.id}|${c.key ?? ""}|${f}`;
    out.push(`<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(`${d.name}${c.name && ctx.deviceComponents(d).length > 1 ? " › " + c.name : ""} · ${ctx.tt(FIELD_LABEL[f] || f)}`)}</option>`);
  }
  return out.join("");
}
const DAYS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

function describeRule(r) {
  const { tt } = ctx;
  const w = r.when || {};
  let when = "";
  if (w.kind === "time") when = `${tt("À")} ${w.at}${w.days?.length && w.days.length < 7 ? ` (${w.days.map((d) => tt(DAYS[d])).join(", ")})` : ""}`;
  else {
    const dev = ctx.devices().find((d) => d.id === w.device);
    when = `${tt("Si")} ${dev?.name || "?"} · ${tt(FIELD_LABEL[w.field] || w.field)} ${w.op} ${w.value}`;
  }
  const sc = r.then?.scene && home.scenes.find((s) => s.id === r.then.scene);
  const then = sc ? `${tt("scène")} « ${sc.name} »` : r.then?.device ? `${ctx.devices().find((d) => d.id === r.then.device)?.name || "?"} → ${tt(stepToForm(r.then)[0] === "off" ? "Éteindre" : "Allumer")}` : "";
  return `${when} → ${[then, r.notify ? tt("alerte") : ""].filter(Boolean).join(" + ")}`;
}

export function renderRules(host) {
  const { tt } = ctx;
  host.innerHTML = `<div class="home-head"><div><h3>${esc(tt("Automatisations"))}</h3>
      <p class="muted">${esc(tt("Si un capteur franchit un seuil, ou à une heure donnée : lancer une scène, commander un objet, vous alerter (capsule et téléphone). Évaluées tant que l'app Domotique est ouverte."))}</p></div>
      <span class="spacer"></span><button type="button" class="btn-soft primary" data-act="new">${esc(tt("＋ Nouvelle règle"))}</button></div>
    <div class="rule-list">${home.rules.map((r) => `<div class="rule-row" data-id="${r.id}">
        <label class="toggle"><input type="checkbox" data-act="toggle"${r.enabled ? " checked" : ""}><span class="track"></span><span class="knob"></span></label>
        <div class="rule-text"><b>${esc(r.name)}</b><span class="muted">${esc(describeRule(r))}</span></div>
        <button type="button" class="btn-soft" data-act="edit">${esc(tt("Modifier"))}</button></div>`).join("")
      || `<div class="empty"><p>${esc(tt("Aucune automatisation pour l'instant."))}</p><p class="muted">${esc(tt("Exemples : alerte si la porte s'ouvre la nuit, lumière du couloir quand une présence est détectée, chauffage d'appoint sous 18 °C, scène « Réveil » à 7 h en semaine."))}</p></div>`}</div>
    <div class="scene-editor rule-editor" hidden></div>`;
  host.onclick = (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const row = b.closest(".rule-row");
    const r = row && home.rules.find((x) => x.id === row.dataset.id);
    if (b.dataset.act === "toggle" && r) { r.enabled = b.checked; saveRules(); }
    else if (b.dataset.act === "edit" && r) editRule(host, r);
    else if (b.dataset.act === "new") editRule(host, { id: uid("rule"), name: "", enabled: true, when: { kind: "sensor", op: ">", value: 25 }, then: {}, notify: true, cooldownMin: 30, fresh: true });
  };
}

function editRule(host, r) {
  const { tt } = ctx;
  const ed = host.querySelector(".rule-editor");
  ed.hidden = false;
  const w = r.when || {};
  const sensorSel = w.device ? `${w.device}|${w.component ?? ""}|${w.field}` : "";
  const thenKind = r.then?.scene ? "scene" : r.then?.device ? "device" : "none";
  const [actKind, actVal] = r.then?.device ? stepToForm(r.then) : ["on", ""];
  ed.innerHTML = `<h3>${esc(tt(r.fresh ? "Nouvelle règle" : "Modifier la règle"))}</h3>
    <label class="fld">${esc(tt("Nom"))}<input class="input ru-name" value="${esc(r.name)}" placeholder="${esc(tt("Ex. : Alerte porte la nuit"))}" /></label>
    <div class="rule-grid">
      <label class="fld">${esc(tt("Déclencheur"))}<select class="select ru-kind">
        <option value="sensor"${w.kind !== "time" ? " selected" : ""}>${esc(tt("Mesure d'un capteur"))}</option>
        <option value="time"${w.kind === "time" ? " selected" : ""}>${esc(tt("Heure"))}</option></select></label>
      <div class="ru-sensor"${w.kind === "time" ? " hidden" : ""}>
        <label class="fld">${esc(tt("Capteur"))}<select class="select ru-sensor-sel">${sensorOptions(sensorSel) || `<option value="">${esc(tt("Aucun capteur"))}</option>`}</select></label>
        <div class="row"><select class="select ru-op">${[">", "<", "="].map((o) => `<option${o === w.op ? " selected" : ""}>${o}</option>`).join("")}</select>
          <input class="input ru-val" value="${esc(w.value ?? "")}" title="${esc(tt("Seuil (1 = présence / ouvert, 0 = rien / fermé)"))}" /></div>
      </div>
      <div class="ru-time"${w.kind === "time" ? "" : " hidden"}>
        <label class="fld">${esc(tt("Heure"))}<input class="input ru-at" type="time" value="${esc(w.at || "07:00")}" /></label>
        <div class="ru-days">${DAYS.map((d, i) => `<label><input type="checkbox" value="${i}"${!w.days?.length || w.days.includes(i) ? " checked" : ""}> ${esc(tt(d))}</label>`).join("")}</div>
      </div>
      <label class="fld">${esc(tt("Action"))}<select class="select ru-then">
        <option value="none"${thenKind === "none" ? " selected" : ""}>${esc(tt("Alerte seulement"))}</option>
        <option value="scene"${thenKind === "scene" ? " selected" : ""}>${esc(tt("Lancer une scène"))}</option>
        <option value="device"${thenKind === "device" ? " selected" : ""}>${esc(tt("Commander un objet"))}</option></select></label>
      <label class="fld ru-scene"${thenKind === "scene" ? "" : " hidden"}>${esc(tt("Scène"))}<select class="select ru-scene-sel">${home.scenes.map((s) => `<option value="${s.id}"${s.id === r.then?.scene ? " selected" : ""}>${esc(s.name)}</option>`).join("") || `<option value="">${esc(tt("Aucune scène"))}</option>`}</select></label>
      <div class="ru-device step-row"${thenKind === "device" ? "" : " hidden"}>
        <select class="select ru-target">${componentOptions(r.then?.device ? `${r.then.device}|${r.then.component ?? ""}` : "")}</select>
        <select class="select ru-act">${ACTIONS.map(([k, l]) => `<option value="${k}"${k === actKind ? " selected" : ""}>${esc(tt(l))}</option>`).join("")}</select>
        <input class="input ru-act-val" value="${esc(actVal)}" placeholder="${esc(tt("valeur"))}" />
      </div>
      <label class="check"><input type="checkbox" class="ru-notify"${r.notify ? " checked" : ""}> ${esc(tt("M'alerter (capsule Halo et téléphone)"))}</label>
      <label class="fld">${esc(tt("Délai minimal entre deux déclenchements (min)"))}<input class="input ru-cool" type="number" min="0" value="${esc(r.cooldownMin ?? 30)}" /></label>
    </div>
    <div class="editor-actions"><span class="spacer"></span>
      ${r.fresh ? "" : `<button type="button" class="btn-soft danger ru-delete">${esc(tt("Supprimer"))}</button>`}
      <button type="button" class="btn-soft ru-cancel">${esc(tt("Annuler"))}</button>
      <button type="button" class="btn-soft primary ru-save">${esc(tt("Enregistrer"))}</button></div>`;
  const $ = (s) => ed.querySelector(s);
  $(".ru-kind").onchange = () => { $(".ru-sensor").hidden = $(".ru-kind").value === "time"; $(".ru-time").hidden = $(".ru-kind").value !== "time"; };
  $(".ru-then").onchange = () => { $(".ru-scene").hidden = $(".ru-then").value !== "scene"; $(".ru-device").hidden = $(".ru-then").value !== "device"; };
  $(".ru-cancel").onclick = () => { ed.hidden = true; };
  $(".ru-delete")?.addEventListener("click", async () => {
    if (!(await confirmSheet({ title: tt("Supprimer cette règle ?"), confirm: tt("Supprimer"), cancel: tt("Annuler"), danger: true }))) return;
    home.rules = home.rules.filter((x) => x.id !== r.id); saveRules(); renderRules(host);
  });
  $(".ru-save").onclick = () => {
    const name = $(".ru-name").value.trim();
    if (!name) { ctx.toast(tt("Donnez un nom à la règle.")); return; }
    let when;
    if ($(".ru-kind").value === "time") {
      when = { kind: "time", at: $(".ru-at").value || "07:00", days: [...ed.querySelectorAll(".ru-days input:checked")].map((x) => Number(x.value)) };
    } else {
      const [device, component, field] = ($(".ru-sensor-sel").value || "||").split("|");
      if (!device) { ctx.toast(tt("Choisissez un capteur.")); return; }
      when = { kind: "sensor", device, component: component === "" ? null : component, field, op: $(".ru-op").value, value: Number(String($(".ru-val").value).replace(",", ".")) || 0 };
    }
    let then = {};
    if ($(".ru-then").value === "scene" && $(".ru-scene-sel").value) then = { scene: $(".ru-scene-sel").value };
    else if ($(".ru-then").value === "device") {
      const [device, comp] = $(".ru-target").value.split("|");
      then = { device, component: comp === "" ? null : comp, action: "set", params: formToParams($(".ru-act").value, $(".ru-act-val").value) };
    }
    const next = { id: r.id, name, enabled: r.enabled !== false, when, then, notify: $(".ru-notify").checked, cooldownMin: Number($(".ru-cool").value) || 0 };
    const i = home.rules.findIndex((x) => x.id === r.id);
    if (i >= 0) home.rules[i] = next; else home.rules.push(next);
    ruleState.delete(r.id);
    saveRules(); renderRules(host);
  };
}
