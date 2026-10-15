import { autoTranslate, tt } from "../apps-i18n.js";
// Village des agents — moteur de scène isométrique « cozy » vivant.
// Données réelles via les commandes Rust (agent_list, agent_activity, agent_save,
// agent_run_now, agent_distill_memory) ; live sur `agents-updated`/`agent-progress`.
// Avatars & apparence : module partagé ../village/sprite.js (correspondance avec
// l'éditeur d'agents). Progression dérivée de l'activité : ./progression.js.

import { buildSprite, defaultAppearance, normalizeAppearance, PW, PH } from "./sprite.js";
import { mcSprite, mcReady, normalizeMc, MC_FRAME } from "./metrocity.js";
import { computeProgress, titleForLevel } from "./progression.js";
import * as Assets from "./assets.js";

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const { listen } = __TAURI.event || {};

const $ = (s) => document.querySelector(s);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

// ===== Géométrie isométrique =====
const TW = 36, TH = 36;          // cellule topdown pixel-tech
const SPRITE_SCALE = 2.4;        // agents plus petits et cohérents avec les stations
const MC_SCALE = 1.5;            // échelle des sprites MetroCity (frame 32px → ~48px à zoom 1)
const PARCEL = 4;                // espacement entre maisons (en tuiles)
const DAY_MS = 180000;           // durée d'un cycle jour/nuit complet (3 min)

const canvas = $("#scene");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

let dpr = window.devicePixelRatio || 1;
let viewW = 0, viewH = 0;
const cam = { x: 0, y: 0, zoom: 1 };
let centroid = { gx: 0, gy: 0 };

let agents = [];
let placed = [];                 // { agent, spawn:{gx,gy} } — spawn = point d'apparition (plus de « home »)
const rt = new Map();            // id -> runtime { pos, target, phase, t, pause }
const progressCache = new Map(); // id -> progress (computeProgress)
const activityCache = new Map(); // id -> texte d'activité courant
let atelier = { gx: 0, gy: 0 };
let selectedId = null, hoverId = null;
let cardTab = "info";
const runningAgents = new Set();  // ids des agents en cours d'exécution (event `agent-running`)
const taskCache = new Map();      // id → libellé de la tâche en cours (event `agent-running`)
const particles = [];            // { x,y,vx,vy,life,max,kind }

// ===== Plan du village (monde, objets placés, zone de travail) =====
const WORLD_DEFAULT = { w: 24, h: 24 };
const ASSET_FOOTPRINT_VERSION = 2;
let layout = { size: { ...WORLD_DEFAULT }, workZone: null, autoDecor: true, objects: [], tiles: {}, zones: [], zonesInitialized: false, assets: {}, assetFootprints: {}, assetFootprintsVersion: ASSET_FOOTPRINT_VERSION };
let editMode = false;           // mode construction
let brush = null;               // asset sélectionné pour pose, ou pinceau système
let buildAction = "select";     // pan | select | paint | erase
let selectedObj = null;         // objet placé sélectionné
// Empreinte (bounding box en cases entières) + échelle appliquée au PROCHAIN objet
// posé avec le pinceau asset actif ; pilotée par les mêmes champs que l'objet
// sélectionné et visualisée par le ghost de placement.
let pendingFootprint = { w: 1, h: 1, scale: 1, layer: "object", solid: true };
// Configuration de pose (panneau de gauche du dock) : type sémantique de ce qu'on
// pose + paramètres des objets spéciaux (fonction IA). Le `pendingFootprint`
// porte la taille/layer/collision ; ceci porte le « quoi ».
let brushCfg = { type: "object", zoneType: "tools", fn: "image", fnConfig: "" };
const PLACEABLE_KINDS = ["tile", "decor", "prop", "house"];
let openSpecialObj = null;       // objet spécial dont la fiche est ouverte
let hoverTile = null;           // { gx, gy } survolé (mode construction)
let draggingObj = null;         // { kind:'obj'|'zone', ref }
let layoutDirty = false, saveTimer = null;

const TILE_TYPES = {
  floor: { label: "Sol", top: "#2f3542", left: "#242a35", right: "#1f2530", solid: false, speed: 1 },
};
const ZONE_TYPES = {
  text: { label: "Texte", icon: "TXT", color: "#7c6cff", keys: ["texte", "text", "redige", "rédige", "resume", "résume", "llm", "prompt", "chat"] },
  image: { label: "Image", icon: "IMG", color: "#ff5ea8", keys: ["image", "photo", "visuel", "dessin", "generate image", "illustration"] },
  files: { label: "Fichiers", icon: "FILE", color: "#34c759", keys: ["fichier", "file", "dossier", "read", "write", "csv", "pdf", "doc"] },
  web: { label: "Web", icon: "WEB", color: "#00a6ff", keys: ["web", "recherche", "search", "internet", "url", "site", "browse"] },
  home: { label: "Domotique", icon: "HOME", color: "#ffb340", keys: ["domotique", "home", "mqtt", "iot", "lampe", "capteur"] },
  gpio: { label: "GPIO", icon: "GPIO", color: "#ff6b3d", keys: ["gpio", "pin", "raspberry", "pwm", "relay", "relais"] },
  memory: { label: "Mémoire", icon: "MEM", color: "#8e7dff", keys: ["memoire", "mémoire", "memory", "learn", "distill", "apprendre"] },
  tools: { label: "Outils", icon: "TOOL", color: "#9aa4b2", keys: ["outil", "tool", "code", "script", "build", "test", "bug", "fix"] },
};
function world() { return layout.size || WORLD_DEFAULT; }
function tileKey(gx, gy) { return `${Math.round(gx)},${Math.round(gy)}`; }
function tileOverride(gx, gy) { return layout.tiles?.[tileKey(gx, gy)] || null; }
function tileHeight(gx, gy) { return clamp(tileOverride(gx, gy)?.h || 0, -1, 3); }
function assetCfg(target) { return layout.assets?.[target] || null; }
function assignedAsset(target) { const c = assetCfg(target); return c?.assetId ? Assets.getAsset(c.assetId) : null; }
function assignedImage(target) { const c = assetCfg(target); return c?.assetId ? Assets.imageFor(c.assetId) : null; }
function assignedSolid(target, fallback = false) { const c = assetCfg(target); return c ? !!c.solid : fallback; }
function assetDefaultLayer(assetId, fallback = "object") {
  const asset = typeof assetId === "string" ? Assets.getAsset(assetId) : assetId;
  if (!asset || asset.kind === "tile") return "floor";
  const cfg = layout.assetFootprints?.[asset.id];
  return cfg?.layer === "wall" ? "wall" : fallback;
}
function assignedFootprint(target, fallback = 1) {
  const asset = assignedAsset(target);
  if (!asset) {
    const s = Math.max(1, Math.round(fallback));
    return { w: s, h: s, scale: 1 };
  }
  return assetSettings(asset);
}
function assetFootprintCfg(assetId) {
  return layout.assetFootprints?.[assetId] || null;
}
function defaultFootprintForAsset(a) {
  if (!a) return { w: 1, h: 1, scale: 1, layer: "object", solid: false };
  if (a.kind === "tile") return { w: 1, h: 1, scale: 1, layer: "floor", solid: false };
  if (a.kind === "decor") return { w: 1, h: 1, scale: 1, layer: "object", solid: false };
  const wPx = Math.max(1, a.w || 0);
  const hPx = Math.max(1, a.h || 0);
  const cat = `${a.category || ""} ${a.name || ""}`.toLowerCase();
  let w = clamp(Math.ceil(wPx / 180), 1, 4);
  let h = clamp(Math.ceil(hPx / 170), 1, 3);
  if (/(plant|greenery|decor|clutter|accessor)/.test(cat)) {
    w = wPx > 190 ? 2 : 1;
    h = hPx > 230 ? 2 : 1;
  } else if (/(desk|table|sofa|counter|shelf|bed|lounge)/.test(cat)) {
    w = clamp(Math.ceil(wPx / 220), 1, 4);
    h = clamp(Math.ceil(hPx / 190), 1, 2);
  } else if (/(fridge|wardrobe|cabinet|door)/.test(cat)) {
    w = wPx > 180 ? 2 : 1;
    h = hPx > 140 ? 2 : 1;
  }
  if (wPx / Math.max(1, hPx) > 5) { w = 3; h = 1; }
  if (wPx && hPx) return { w, h, scale: 1, layer: "object", solid: true };
  return { w: 1, h: 1, scale: 1, layer: "object", solid: true };
}
function footprintForAsset(a) {
  const cfg = assetFootprintCfg(a?.id);
  if (cfg) return { w: clamp(parseInt(cfg.w || 1, 10), 1, 6), h: clamp(parseInt(cfg.h || 1, 10), 1, 6), scale: clamp(parseFloat(cfg.scale || 1), 0.4, 1.4), layer: cfg.layer === "wall" ? "wall" : (a?.kind === "tile" ? "floor" : "object"), solid: cfg.solid == null ? a?.kind !== "decor" && a?.kind !== "tile" : !!cfg.solid };
  return defaultFootprintForAsset(a);
}
function assetSettings(assetOrId) {
  const asset = typeof assetOrId === "string" ? Assets.getAsset(assetOrId) : assetOrId;
  return footprintForAsset(asset);
}
function saveAssetSettings(assetId, patch) {
  const asset = Assets.getAsset(assetId);
  if (!asset || asset.kind === "tile") return null;
  const current = assetSettings(asset);
  const next = {
    w: clamp(parseInt(patch.w ?? current.w, 10), 1, 6),
    h: clamp(parseInt(patch.h ?? current.h, 10), 1, 6),
    scale: clamp(parseFloat(patch.scale ?? current.scale), 0.4, 1.4),
    layer: patch.layer === "wall" ? "wall" : (current.layer === "wall" ? "wall" : "object"),
    solid: patch.solid == null ? !!current.solid : !!patch.solid,
  };
  layout.assetFootprints = layout.assetFootprints || {};
  layout.assetFootprintsVersion = ASSET_FOOTPRINT_VERSION;
  layout.assetFootprints[assetId] = next;
  scheduleSave();
  return next;
}
function containImageRect(img, boxW, boxH, scale = 1) {
  const ar = img.naturalWidth / Math.max(1, img.naturalHeight);
  const sc = clamp(scale || 1, 0.4, 1.4);
  let iw = boxW * 0.96, ih = iw / ar;
  if (ih > boxH * 0.96) { ih = boxH * 0.96; iw = ih * ar; }
  iw *= sc; ih *= sc;
  if (iw > boxW) { const k = boxW / iw; iw *= k; ih *= k; }
  if (ih > boxH) { const k = boxH / ih; iw *= k; ih *= k; }
  return { iw, ih };
}
function setTile(gx, gy, patch) {
  layout.tiles = layout.tiles || {};
  const k = tileKey(gx, gy);
  const next = Object.assign({}, layout.tiles[k] || {}, patch);
  if (!next.type && !next.h) delete layout.tiles[k];
  else layout.tiles[k] = next;
}
function migrateLayeredLayout() {
  layout.objects = Array.isArray(layout.objects) ? layout.objects : [];
  layout.tiles = layout.tiles || {};
  const wallKeys = [];
  for (const [k, tile] of Object.entries(layout.tiles)) {
    if (tile?.type === "wall") wallKeys.push(k);
  }
  for (const k of wallKeys) {
    const [gx, gy] = k.split(",").map(Number);
    clearTileContent(gx, gy);
    layout.objects.push({ id: `wall-${gx}-${gy}`, layer: "wall", gx, gy, scale: 1, gridW: 1, gridH: 1, solid: true });
    delete layout.tiles[k].type;
    if (!layout.tiles[k].h) delete layout.tiles[k];
  }
}
function migrateAssetFootprintScale() {
  layout.assetFootprints = layout.assetFootprints || {};
  const oldVersion = layout.assetFootprintsVersion || 1;
  if (oldVersion >= ASSET_FOOTPRINT_VERSION) return false;
  let changed = false;
  for (const [assetId, cfg] of Object.entries(layout.assetFootprints)) {
    const asset = Assets.getAsset(assetId);
    if (!asset || asset.kind === "tile" || asset.kind === "decor") continue;
    const next = defaultFootprintForAsset(asset);
    const w = clamp(parseInt(cfg?.w || 1, 10), 1, 6);
    const h = clamp(parseInt(cfg?.h || 1, 10), 1, 6);
    if (w > next.w || h > next.h) {
      layout.assetFootprints[assetId] = { ...cfg, w: next.w, h: next.h, scale: 1 };
      changed = true;
    }
  }
  layout.assetFootprintsVersion = ASSET_FOOTPRINT_VERSION;
  return changed || oldVersion !== ASSET_FOOTPRINT_VERSION;
}
function hydrateObjectFootprintsFromAssets() {
  let changed = false;
  const migratedScale = migrateAssetFootprintScale();
  if (migratedScale) changed = true;
  for (const o of layout.objects || []) {
    if (!o.assetId || o.layer === "wall") continue;
    const currentW = Math.max(1, Math.round(o.gridW || 1));
    const currentH = Math.max(1, Math.round(o.gridH || 1));
    const asset = Assets.getAsset(o.assetId);
    const fp = footprintForAsset(asset);
    if (!o.layer) { o.layer = fp.layer === "wall" ? "wall" : "object"; changed = true; }
    if (o.solid == null) { o.solid = !!fp.solid; changed = true; }
    if ((currentW === 1 && currentH === 1 && (fp.w > 1 || fp.h > 1)) || (migratedScale && (currentW > fp.w || currentH > fp.h))) {
      o.gridW = fp.w;
      o.gridH = fp.h;
      o.scale = 1;
      changed = true;
    } else if ((o.scale || 1) > 1.4) {
      o.scale = 1;
      changed = true;
    }
  }
  if (changed) scheduleSave();
}
function clearTileContent(gx, gy) {
  const x = Math.round(gx), y = Math.round(gy);
  const before = layout.objects.length;
  layout.objects = layout.objects.filter((o) => !objectCoversTile(o, x, y));
  return before !== layout.objects.length;
}
function clearTileAt(gx, gy) {
  if (clearTileContent(gx, gy)) return true;
  const k = tileKey(gx, gy);
  if (layout.tiles?.[k]) { delete layout.tiles[k]; return true; }
  return false;
}
function ensureDefaultZones(force = false) {
  layout.zones = Array.isArray(layout.zones) ? layout.zones : [];
  if (layout.zonesInitialized && !force) return;
  const W = world();
  const cx = Math.floor(W.w / 2), cy = Math.floor(W.h / 2);
  const defaults = [
    ["text", cx - 3, cy - 3],
    ["image", cx + 3, cy - 3],
    ["files", cx - 6, cy + 1],
    ["web", cx + 6, cy + 1],
    ["home", cx - 4, cy + 6],
    ["gpio", cx + 4, cy + 6],
    ["memory", cx, cy - 7],
    ["tools", cx, cy + 2],
  ];
  for (const [type, gx, gy] of defaults) {
    if (!layout.zones.some((z) => z.type === type)) layout.zones.push({ id: `z-${type}`, type, gx: clamp(gx, 0, W.w - 1), gy: clamp(gy, 0, W.h - 1) });
  }
  if (layout.workZone && !layout.zones.some((z) => z.type === "tools")) {
    layout.zones.push({ id: "z-tools", type: "tools", gx: layout.workZone.gx, gy: layout.workZone.gy });
  }
  layout.zonesInitialized = true;
  normalizeZones();
}
function normalizeZones() {
  layout.zones = Array.isArray(layout.zones) ? layout.zones : [];
  const byType = new Map();
  for (const z of layout.zones) byType.set(z.type || "tools", z);
  if (byType.size !== layout.zones.length) {
    layout.zones = [...byType.values()];
    scheduleSave();
  }
}
function zoneOf(type) {
  return layout.zones.find((z) => z.type === type) || layout.zones.find((z) => z.type === "tools") || layout.zones[0] || { type: "tools", gx: atelier.gx, gy: atelier.gy };
}
// Classe un texte de tâche vers un type de station (clé de ZONE_TYPES).
function classifyText(txt) {
  const t = String(txt || "").toLowerCase();
  for (const [type, cfg] of Object.entries(ZONE_TYPES)) if (cfg.keys.some((k) => t.includes(k))) return type;
  return "tools";
}
function classifyTask(agent) {
  return classifyText(`${firstPendingTask(agent) || ""} ${activityCache.get(agent.id) || ""}`);
}
// Réduit une tâche à l'une des 3 fonctions des objets spéciaux (image/texte/tool).
function taskFn(txt) {
  const type = classifyText(txt);
  if (type === "image") return "image";
  if (type === "text") return "text";
  return "tool";
}
function zoneFn(type) {
  if (type === "image") return "image";
  if (type === "text") return "text";
  return "tool";
}
function ensureZoneSpecial(z) {
  if (!z) return null;
  const cfg = ZONE_TYPES[z.type] || ZONE_TYPES.tools;
  z.special = z.special || {};
  z.special.fn = z.special.fn || zoneFn(z.type);
  z.special.config = z.special.config || cfg.label;
  z.special.history = z.special.history || [];
  return z;
}
function findSpecialTarget(ref) {
  if (!ref) return null;
  return (layout.objects || []).find((x) => x.id === ref.id)
    || (layout.zones || []).find((x) => x.id === ref.id)
    || ref;
}
// Objets spéciaux posés (optionnellement filtrés par fonction).
function specialObjects(fn) {
  return (layout.objects || []).filter((o) => o.special && (!fn || o.special.fn === fn));
}
// Objet spécial le plus proche d'une position, pour une fonction donnée.
function nearestSpecialObject(fn, from) {
  let best = null, bd = Infinity;
  for (const o of specialObjects(fn)) {
    const f = objectFootprint(o);
    const d = Math.hypot(f.x0 + f.w / 2 - from.gx, f.y0 + f.h / 2 - from.gy);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}
// Journalise l'usage d'un objet spécial par un agent (persisté dans le layout).
function logUsage(obj, agentId, task) {
  if (obj?.type) ensureZoneSpecial(obj);
  if (!obj?.special) return;
  obj.special.history = obj.special.history || [];
  const agent = findAgent(agentId);
  obj.special.history.unshift({ agentId, name: agent?.name || agentId, ts: Date.now(), task: String(task || "").slice(0, 140) });
  if (obj.special.history.length > 30) obj.special.history.length = 30;
  scheduleSave();
  if (openSpecialObj && openSpecialObj.id === obj.id) renderSpecialHistory(obj);
}
// Un agent démarre une tâche : on journalise sur l'objet spécial le plus proche
// dont la fonction correspond (il s'y dirige aussi, cf. pickTarget).
function recordAutoUsage(agentId, task) {
  if (!task) return;
  const r = rt.get(agentId);
  const so = nearestSpecialObject(taskFn(task), r ? r.pos : { gx: 0, gy: 0 });
  if (so) logUsage(so, agentId, task);
}
function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  const m = Math.floor(s / 60); if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60); if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}
function scheduleSave() {
  layoutDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { if (!invoke || !layoutDirty) return; layoutDirty = false; try { await invoke("village_layout_save", { data: layout }); } catch {} }, 600);
}
async function loadLayout() {
  if (!invoke) return;
  try {
    const data = await invoke("village_layout_load");
    if (data && typeof data === "object") {
      layout = Object.assign({ size: { ...WORLD_DEFAULT }, workZone: null, autoDecor: true, objects: [], tiles: {}, zones: [], zonesInitialized: false, assets: {}, assetFootprints: {}, assetFootprintsVersion: 1 }, data);
      if (!layout.size || !layout.size.w) layout.size = { ...WORLD_DEFAULT };
      layout.objects = layout.objects || [];
      delete layout.homes;   // notion de « home » supprimée
      layout.tiles = layout.tiles || {};
      layout.zones = layout.zones || [];
      if (layout.zonesInitialized == null) layout.zonesInitialized = layout.zones.length > 0;
      layout.assets = layout.assets || {};
      layout.assetFootprints = layout.assetFootprints || {};
      migrateLayeredLayout();
    }
  } catch {}
  migrateLayeredLayout();
  normalizeZones();
  if (!layout.zonesInitialized && !(layout.zones || []).length) ensureDefaultZones(true);
}

// ===== Apparence / sprites (cache) =====
const spriteCache = new Map();
function appearanceOf(agent) { return normalizeAppearance(agent.appearance, agent.id); }
function spriteFor(agent, state, frame, walk = false) {
  const lvl = progressCache.get(agent.id)?.level || 1;
  const a = appearanceOf(agent);
  const key = `${agent.id}|${state}|${frame}|${walk ? "w" : "s"}|${lvl}|${JSON.stringify(a)}`;
  let s = spriteCache.get(key);
  if (!s) { s = buildSprite(a, { state, frame, walk, level: lvl, seed: agent.id }); spriteCache.set(key, s); }
  if (spriteCache.size > 400) spriteCache.clear();
  return s;
}

// ===== État d'un agent =====
function deriveState(agent) {
  // Un agent réellement en cours d'exécution (événement `agent-running`) est « au
  // travail », même si la tâche se termine très vite ou s'il est désactivé : c'est
  // ce qui rend l'état visible dans l'atelier pendant le traitement.
  if (runningAgents.has(agent.id)) return "work";
  if (!agent.enabled) return "sleep";
  const now = Math.floor(Date.now() / 1000);
  const pending = (agent.tasks || []).some((t) => !t.done && (t.due == null || t.due <= now));
  return pending ? "work" : "idle";
}
function firstPendingTask(agent) {
  const now = Math.floor(Date.now() / 1000);
  const t = (agent.tasks || []).find((x) => !x.done && (x.due == null || x.due <= now));
  return t ? t.text : null;
}

// ===== Conversion grille -> écran (avec zoom) =====
function worldToScreen(gx, gy) {
  const z = cam.zoom;
  const dx = (gx - centroid.gx), dy = (gy - centroid.gy);
  return {
    x: viewW / 2 + dx * TW * z + cam.x,
    y: viewH / 2 + dy * TH * z + cam.y,
  };
}

// ===== Placement : monde fixe, maisons d'agents (auto ou override), zone de travail =====
function relayout() {
  placed = [];
  ensureDefaultZones();
  const W = world();
  centroid = { gx: W.w / 2, gy: W.h / 2 };
  // Zone de travail : override du plan, sinon centre du monde
  const work = zoneOf("tools");
  atelier = { gx: work.gx, gy: work.gy };
  const n = agents.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  // Auto-placement réparti dans l'intérieur du monde (évite les bords)
  const margin = 2, span = Math.max(1, Math.min(W.w, W.h) - margin * 2 - 1);
  agents.forEach((agent, i) => {
    // Point d'apparition réparti dans la grille (plus de « home » figé ni persisté).
    const col = i % cols, row = Math.floor(i / cols);
    const step = span / Math.max(1, cols);
    const spawn = { gx: Math.round(margin + col * step + 1), gy: Math.round(margin + row * step + 1) };
    // décale pour ne pas tomber sur la zone de travail
    if (spawn.gx === atelier.gx && spawn.gy === atelier.gy) spawn.gx += 2;
    placed.push({ agent, spawn });
    if (!rt.has(agent.id)) {
      // Démarre sur une tuile libre adjacente au point d'apparition (centre entier).
      rt.set(agent.id, { pos: nearestFreeAround(spawn.gx, spawn.gy + 1), target: null, phase: "idle", t: 0, pause: 0 });
    }
  });
  for (const id of [...rt.keys()]) if (!agents.find((a) => a.id === id)) rt.delete(id);
}

function groundBounds() {
  const W = world();
  return { x0: 0, y0: 0, x1: W.w - 1, y1: W.h - 1 };
}
function inWorld(gx, gy) { const W = world(); return gx >= 0 && gy >= 0 && gx <= W.w - 1 && gy <= W.h - 1; }

// Décor automatique retiré : la map n'affiche plus que ce que l'utilisateur pose.
function decorAt(_gx, _gy) { return null; }

// ===== Objets placés / obstacles =====
function isSolidTile(gx, gy) {
  const x = Math.round(gx), y = Math.round(gy);
  if (layout.objects.some((o) => objectCoversTile(o, x, y) && o.solid !== false)) return true;
  if ((layout.zones || []).some((z) => zoneCoversTile(z, x, y) && assignedSolid(`zone:${z.type}`, true))) return true;
  if (placed.some((p) => Math.round(p.spawn.gx) === x && Math.round(p.spawn.gy) === y)) return true;
  const type = tileBiome(x, y);
  if (assignedSolid(`tile:${type}`, false)) return true;
  return false;
}
function objectFootprint(o) {
  const s = Math.max(1, Math.round(o.scale || 1));
  const w = Math.max(1, Math.round(o.gridW || s));
  const h = Math.max(1, Math.round(o.gridH || s));
  return { w, h, x0: Math.round(o.gx) - Math.floor(w / 2), y0: Math.round(o.gy) - Math.floor(h / 2) };
}
function objectCoversTile(o, gx, gy) {
  const f = objectFootprint(o);
  return gx >= f.x0 && gy >= f.y0 && gx < f.x0 + f.w && gy < f.y0 + f.h;
}
// Empreinte de cases (entières) centrée sur (gx,gy) pour une largeur/hauteur de
// grille données — utilisée par l'aperçu de placement.
function footprintCells(gx, gy, w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  return { w, h, x0: Math.round(gx) - Math.floor(w / 2), y0: Math.round(gy) - Math.floor(h / 2) };
}
// Géométrie écran d'une empreinte : coin haut-gauche + dimensions de la boîte.
// Les tuiles sont centrées sur les entiers → le coin = (x0-0.5, y0-0.5).
function footprintScreen(f) {
  const z = cam.zoom;
  const tl = worldToScreen(f.x0 - 0.5, f.y0 - 0.5);
  return { tl, boxW: f.w * TW * z, boxH: f.h * TH * z, z };
}
// Le pinceau actif est-il un asset (vs pinceau système bloc agent) ?
function isAssetBrush() {
  return !!(brush && typeof brush === "object" && brush.id && brush.data && !brush.type);
}
function isPaintBrush() {
  return isAssetBrush() || brush?.type === "zone";
}
function zoneFootprint(z) {
  const fp = assignedFootprint(`zone:${z.type}`, 1);
  const w = Math.max(1, Math.round(z.gridW || fp.w));
  const h = Math.max(1, Math.round(z.gridH || fp.h));
  return { w, h, x0: Math.round(z.gx) - Math.floor(w / 2), y0: Math.round(z.gy) - Math.floor(h / 2) };
}
function zoneCoversTile(z, gx, gy) {
  const f = zoneFootprint(z);
  return gx >= f.x0 && gy >= f.y0 && gx < f.x0 + f.w && gy < f.y0 + f.h;
}
function nearestFreeAround(gx, gy) {
  const sx = Math.round(gx), sy = Math.round(gy);
  for (let r = 0; r <= 5; r++) {
    for (let y = sy - r; y <= sy + r; y++) for (let x = sx - r; x <= sx + r; x++) {
      if (Math.max(Math.abs(x - sx), Math.abs(y - sy)) !== r) continue;
      if (!isBlocked(x, y)) return { gx: x, gy: y };
    }
  }
  return { gx, gy };
}
function zoneAtScreen(mx, my) {
  const sorted = [...(layout.zones || [])].sort((a, b) => (b.gx + b.gy) - (a.gx + a.gy));
  let nearest = null;
  let nearestDist = Infinity;
  for (const z of sorted) {
    const f = zoneFootprint(z);
    const { tl, boxW, boxH } = footprintScreen(f);
    const pad = Math.max(14, 10 * cam.zoom);
    if (z._box && mx >= z._box.x - pad && mx <= z._box.x + z._box.w + pad && my >= z._box.y - pad && my <= z._box.y + z._box.h + pad) return z;
    if (mx >= tl.x - pad && mx <= tl.x + boxW + pad && my >= tl.y - pad && my <= tl.y + boxH + 18 * cam.zoom + pad) return z;

    // Fallback volontairement permissif : les skins de blocs agents peuvent être
    // plus petits que leur empreinte, et certains assets donnent une impression
    // de décalage. On sélectionne donc le bloc le plus proche de son ancre visuelle.
    const anchor = worldToScreen(z.gx, z.gy);
    const dx = Math.abs(mx - anchor.x);
    const dy = Math.abs(my - anchor.y);
    const rx = Math.max(34, boxW * 0.72);
    const ry = Math.max(42, boxH * 0.95);
    if (dx <= rx && dy <= ry) {
      const d = dx * dx + dy * dy;
      if (d < nearestDist) { nearest = z; nearestDist = d; }
    }
  }
  return nearest;
}
function objectAtScreen(mx, my) {
  // Du plus proche (devant) au plus loin
  const sorted = [...layout.objects].sort((a, b) => (b.gx + b.gy) - (a.gx + a.gy));
  for (const o of sorted) {
    if (o.layer === "wall") {
      const f = objectFootprint(o);
      const { tl, boxW, boxH } = footprintScreen(f);
      if (mx >= tl.x && mx <= tl.x + boxW && my >= tl.y - boxH * 0.7 && my <= tl.y + boxH) return o;
      continue;
    }
    const f = objectFootprint(o);
    const { tl, boxW, boxH } = footprintScreen(f);
    if (mx >= tl.x && mx <= tl.x + boxW && my >= tl.y && my <= tl.y + boxH) return o;
  }
  return null;
}
// Tuile sous le curseur (pour poser)
function tileAtScreen(mx, my) {
  const z = cam.zoom;
  const gx = centroid.gx + (mx - viewW / 2 - cam.x) / (TW * z);
  const gy = centroid.gy + (my - viewH / 2 - cam.y) / (TH * z);
  return { gx, gy };
}
function hash2(a, b) { let h = (a * 73856093) ^ (b * 19349663); return (h >>> 0); }

// ===== Cycle jour/nuit =====
function dayPhase() { return (Date.now() % DAY_MS) / DAY_MS; }     // 0..1
// 0 = aube, .25 jour, .5 crépuscule, .75 nuit
function skyColors(phase) {
  // Interpolation entre 4 ambiances
  // Palette sobre façon macOS : bleus-gris doux, aube et crépuscule discrets.
  const stops = [
    { t: 0.0, top: [46, 54, 76], bot: [104, 96, 116] },   // aube douce
    { t: 0.28, top: [56, 70, 100], bot: [112, 132, 164] },// jour bleu-gris
    { t: 0.5, top: [60, 58, 88], bot: [142, 104, 112] },  // crépuscule discret
    { t: 0.72, top: [18, 22, 36], bot: [40, 46, 66] },    // nuit profonde
    { t: 1.0, top: [46, 54, 76], bot: [104, 96, 116] },
  ];
  let a = stops[0], b = stops[1];
  for (let i = 0; i < stops.length - 1; i++) { if (phase >= stops[i].t && phase <= stops[i + 1].t) { a = stops[i]; b = stops[i + 1]; break; } }
  const k = (phase - a.t) / Math.max(1e-6, b.t - a.t);
  const mix = (x, y) => Math.round(lerp(x, y, k));
  const top = a.top.map((v, i) => mix(v, b.top[i]));
  const bot = a.bot.map((v, i) => mix(v, b.bot[i]));
  return { top: `rgb(${top.join(",")})`, bot: `rgb(${bot.join(",")})` };
}
function isNight() { const p = dayPhase(); return p > 0.6 && p < 0.92; }

// ===== Dessin : tuiles, décor, maisons, atelier =====
// Tuile en cube iso (façon Minecraft) : face haute + 2 côtés ombrés.
const CUBE_H = 7;               // hauteur du bloc (px à zoom 1)
function tileBiome(gx, gy) {
  const over = tileOverride(gx, gy);
  if (over?.type && TILE_TYPES[over.type]) return over.type;
  return "floor";
}
const BIOME = {
  floor: TILE_TYPES.floor,
};
function drawTile(sx, sy, gx, gy, night) {
  const z = cam.zoom, w = TW * z, h = TH * z;
  const type = tileBiome(gx, gy);
  const b = BIOME[type] || BIOME.floor;
  const tileImg = tileOverride(gx, gy)?.assetId ? Assets.imageFor(tileOverride(gx, gy).assetId) : assignedImage(`tile:${type}`);
  ctx.fillStyle = b.top;
  ctx.fillRect(Math.round(sx - w / 2), Math.round(sy - h / 2), Math.ceil(w), Math.ceil(h));
  if (Assets.isReady(tileImg)) {
    ctx.drawImage(tileImg, Math.round(sx - w / 2), Math.round(sy - h / 2), Math.ceil(w), Math.ceil(h));
  }
  ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.lineWidth = 1;   // grille discrète
  ctx.strokeRect(Math.round(sx - w / 2) + 0.5, Math.round(sy - h / 2) + 0.5, Math.ceil(w), Math.ceil(h));
}

function drawDecor(kind, sx, sy, gx, gy) {
  const z = cam.zoom;
  ctx.fillStyle = kind === "terminal" ? "#58d68d" : "#7c6cff";
  ctx.fillRect(sx - 6 * z, sy - 6 * z, 12 * z, 12 * z);
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fillRect(sx - 3 * z, sy - 3 * z, 6 * z, 2 * z);
}
function ellipse(x, y, rx, ry) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }

// Maison évolutive (tier 0..3). working → fumée ; night → fenêtre allumée.
function drawZone(zn) {
  const cfg = ZONE_TYPES[zn.type] || ZONE_TYPES.tools;
  const z = cam.zoom;
  const custom = assignedImage(`zone:${zn.type}`);
  const customFp = assignedFootprint(`zone:${zn.type}`, 1);
  const f = zoneFootprint(zn);
  const { tl, boxW, boxH } = footprintScreen(f);
  const cxS = tl.x + boxW / 2;
  const bottomS = tl.y + boxH;
  const labelPad = 16 * z;
  zn._box = { x: tl.x, y: tl.y, w: boxW, h: boxH + labelPad };
  const pulse = 0.5 + Math.sin(Date.now() / 480 + zn.gx) * 0.5;
  if (Assets.isReady(custom)) {
    ctx.fillStyle = "rgba(40,30,70,0.16)";
    ellipse(cxS, bottomS - 3 * z, boxW * 0.32, boxH * 0.11);
    if (editMode || selectedObj === zn) {
      ctx.save();
      ctx.strokeStyle = selectedObj === zn ? "#fff" : "rgba(10,132,255,0.4)";
      ctx.lineWidth = selectedObj === zn ? 2 : 1;
      if (selectedObj === zn) ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.round(tl.x) + 0.5, Math.round(tl.y) + 0.5, Math.round(boxW), Math.round(boxH));
      ctx.restore();
    }
    const { iw, ih } = containImageRect(custom, boxW, boxH, zn.scale || customFp.scale);
    ctx.drawImage(custom, Math.round(cxS - iw / 2), Math.round(bottomS - ih), Math.round(iw), Math.round(ih));
    ctx.save();
    ctx.font = `${Math.round(8 * z)}px -apple-system, system-ui`;
    ctx.textAlign = "center"; ctx.fillStyle = "#c9d7ea";
    ctx.fillText(cfg.label, cxS, bottomS + 10 * z);
    ctx.restore();
    return;
  }
  const pad = 4 * z;
  ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(tl.x + 3 * z, tl.y + 4 * z, boxW, boxH);
  ctx.fillStyle = "#141b28"; ctx.fillRect(tl.x, tl.y, boxW, boxH);
  ctx.strokeStyle = cfg.color; ctx.lineWidth = 2 * z; ctx.strokeRect(tl.x, tl.y, boxW, boxH);
  ctx.fillStyle = `rgba(255,255,255,${0.10 + pulse * 0.08})`; ctx.fillRect(tl.x + pad, tl.y + pad, Math.max(0, boxW - pad * 2), 9 * z);
  ctx.fillStyle = cfg.color;
  const s = { x: cxS, y: tl.y + boxH * 0.52 };
  if (zn.type === "image") {
    ctx.fillRect(s.x - 14 * z, s.y - 4 * z, 28 * z, 16 * z);
    ctx.fillStyle = "#101722"; ctx.fillRect(s.x - 9 * z, s.y, 6 * z, 5 * z); ctx.fillRect(s.x + 3 * z, s.y - 1 * z, 7 * z, 7 * z);
  } else if (zn.type === "web") {
    ctx.beginPath(); ctx.arc(s.x, s.y + 4 * z, 12 * z, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s.x - 12 * z, s.y + 4 * z); ctx.lineTo(s.x + 12 * z, s.y + 4 * z); ctx.stroke();
  } else if (zn.type === "gpio") {
    for (let i = -2; i <= 2; i++) ctx.fillRect(s.x + i * 6 * z - 2 * z, s.y - 6 * z, 4 * z, 18 * z);
  } else if (zn.type === "home") {
    ctx.fillRect(s.x - 12 * z, s.y - 5 * z, 24 * z, 17 * z);
    ctx.fillStyle = "#141b28"; ctx.fillRect(s.x - 4 * z, s.y, 8 * z, 12 * z);
  } else {
    for (let i = -1; i <= 1; i++) ctx.fillRect(s.x - 14 * z, s.y + i * 7 * z - 2 * z, 28 * z, 4 * z);
  }
  ctx.save();
  ctx.font = `700 ${Math.round(8 * z)}px -apple-system, system-ui`;
  ctx.textAlign = "center"; ctx.fillStyle = "#e9f3ff";
  ctx.fillText(cfg.icon, s.x, s.y - 7 * z);
  ctx.font = `${Math.round(8 * z)}px -apple-system, system-ui`;
  ctx.fillStyle = "#c9d7ea"; ctx.fillText(cfg.label, s.x, bottomS + 10 * z);
  ctx.restore();
  if (editMode || selectedObj === zn) {
    ctx.save();
    ctx.strokeStyle = selectedObj === zn ? "#fff" : "rgba(10,132,255,0.4)";
    ctx.lineWidth = selectedObj === zn ? 2 : 1;
    if (selectedObj === zn) ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(tl.x) + 0.5, Math.round(tl.y) + 0.5, Math.round(boxW), Math.round(boxH));
    ctx.restore();
  }
}

// Objet placé (image asset). Ancré au sol, échelle réglable, contour si sélectionné.
function drawObject(o) {
  const z = cam.zoom;
  const f = objectFootprint(o);
  const { tl, boxW, boxH } = footprintScreen(f);
  const cxS = tl.x + boxW / 2;        // centre horizontal de l'empreinte
  const bottomS = tl.y + boxH;        // bas de l'empreinte (les objets « posent » dessus)
  const img = Assets.imageFor(o.assetId);
  const sc = clamp(o.scale || 1, 0.4, 1.4);
  if (o.layer === "wall") {
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(tl.x + 2 * z, tl.y - boxH * 0.7 + 3 * z, boxW, boxH * 1.7);
    if (Assets.isReady(img)) {
      const { iw, ih } = containImageRect(img, boxW, boxH * 1.7, sc);
      ctx.drawImage(img, Math.round(cxS - iw / 2), Math.round(tl.y + boxH - ih), Math.round(iw), Math.round(ih));
    } else {
      ctx.fillStyle = "rgba(20,27,40,0.72)";
      ctx.fillRect(Math.round(tl.x), Math.round(tl.y - boxH * 0.7), Math.round(boxW), Math.round(boxH * 1.7));
      ctx.strokeStyle = "rgba(10,132,255,0.3)";
      ctx.strokeRect(Math.round(tl.x) + 0.5, Math.round(tl.y - boxH * 0.7) + 0.5, Math.round(boxW), Math.round(boxH * 1.7));
    }
    if (editMode) {
      ctx.save();
      ctx.strokeStyle = selectedObj === o ? "#0a84ff" : "rgba(10,132,255,0.38)";
      ctx.lineWidth = selectedObj === o ? 2 : 1;
      if (selectedObj === o) ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.round(tl.x) + 0.5, Math.round(tl.y) + 0.5, Math.round(boxW), Math.round(boxH));
      ctx.restore();
    }
    return;
  }
  // Ombre au sol (ellipse à la base de l'empreinte)
  ctx.fillStyle = "rgba(40,30,70,0.16)";
  ellipse(cxS, bottomS - 3 * z, boxW * 0.34, boxH * 0.12);
  // Contour de la boîte (cases occupées) — repère d'alignement en mode édition.
  if (editMode) {
    ctx.save();
    ctx.strokeStyle = selectedObj === o ? "#7c6cff" : "rgba(124,108,255,0.35)";
    ctx.lineWidth = selectedObj === o ? 2 : 1;
    if (selectedObj === o) ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(tl.x) + 0.5, Math.round(tl.y) + 0.5, Math.round(boxW), Math.round(boxH));
    ctx.restore();
  }
  if (Assets.isReady(img)) {
    // Ajustement « contain » dans la boîte, ancré en bas-centre. La bbox en
    // cases reste l'autorité ; l'échelle n'est qu'un ajustement fin.
    // l'objet remplit son empreinte par défaut et ne déborde plus.
    const { iw, ih } = containImageRect(img, boxW, boxH, sc);
    ctx.drawImage(img, Math.round(cxS - iw / 2), Math.round(bottomS - ih), Math.round(iw), Math.round(ih));
  } else {
    ctx.fillStyle = "rgba(124,108,255,0.4)";
    ctx.fillRect(cxS - boxW / 2, bottomS - boxH, boxW, boxH);
  }
  // Objet spécial (fonction IA) : pastille ✨ pour le repérer.
  if (o.special) {
    const r = 9 * z, bx = cxS, by = tl.y + r + 2 * z;
    ctx.fillStyle = "rgba(124,108,255,0.95)";
    ellipse(bx, by, r, r);
    ctx.fillStyle = "#fff";
    ctx.font = `${Math.round(11 * z)}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("✨", bx, by + 0.5 * z);
  }
}

// Aperçu de pose : sous le curseur, dessine l'empreinte (cases vertes = libres,
// rouges = collision) et un fantôme de l'objet ajusté à la boîte.
function drawPlacementGhost() {
  if (!editMode || buildAction !== "paint" || !hoverTile || !isAssetBrush()) return;
  const z = cam.zoom;
  const f = footprintCells(hoverTile.gx, hoverTile.gy, pendingFootprint.w, pendingFootprint.h);
  const willBeSolid = !!pendingFootprint.solid;
  ctx.save();
  let anyBlocked = false;
  for (let yy = 0; yy < f.h; yy++) for (let xx = 0; xx < f.w; xx++) {
    const gx = f.x0 + xx, gy = f.y0 + yy;
    // Une case est « invalide » si hors-monde, ou si l'objet est solide et la
    // case est déjà bloquée (mur/objet/eau).
    const blocked = !inWorld(gx, gy) || (willBeSolid && pendingFootprint.layer === "wall" && isBlocked(gx, gy));
    if (blocked) anyBlocked = true;
    const s = worldToScreen(gx, gy);
    ctx.fillStyle = blocked ? "rgba(255,70,90,0.32)" : "rgba(110,240,170,0.26)";
    ctx.fillRect(s.x - TW * z / 2, s.y - TH * z / 2, TW * z, TH * z);
    ctx.strokeStyle = blocked ? "rgba(255,70,90,0.85)" : "rgba(110,240,170,0.75)";
    ctx.strokeRect(s.x - TW * z / 2 + 0.5, s.y - TH * z / 2 + 0.5, TW * z, TH * z);
  }
  const { tl, boxW, boxH } = footprintScreen(f);
  const img = Assets.imageFor(brush.id);
  if (Assets.isReady(img)) {
    const sc = clamp(pendingFootprint.scale || 1, 0.4, 1.4);
    const { iw, ih } = containImageRect(img, boxW, boxH, sc);
    ctx.globalAlpha = anyBlocked ? 0.45 : 0.78;
    ctx.drawImage(img, Math.round(tl.x + boxW / 2 - iw / 2), Math.round(tl.y + boxH - ih), Math.round(iw), Math.round(ih));
  }
  ctx.restore();
}

// ===== Bulles / labels / overlays =====
function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawBubble(sx, topY, text, accent) {
  ctx.save(); ctx.font = "11px -apple-system, system-ui, sans-serif";
  const w = Math.min(180, ctx.measureText(text).width + 16), h = 20;
  const x = sx - w / 2, y = topY - h - 8;
  ctx.fillStyle = "rgba(255,255,255,0.96)"; ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
  roundRect(x, y, w, h, 7); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(sx - 5, y + h); ctx.lineTo(sx + 5, y + h); ctx.lineTo(sx, y + h + 6); ctx.closePath();
  ctx.fillStyle = "rgba(255,255,255,0.96)"; ctx.fill();
  ctx.fillStyle = "#2b2540"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text.length > 28 ? text.slice(0, 27) + "…" : text, sx, y + h / 2);
  ctx.restore();
}
function drawLabel(sx, sy, name, state, level) {
  ctx.save(); ctx.font = "600 11px -apple-system, system-ui, sans-serif";
  const lvlTxt = level ? ` · N${level}` : "";
  const txt = name + lvlTxt;
  const w = ctx.measureText(txt).width + 16;
  const x = sx - w / 2, y = sy;
  ctx.fillStyle = "rgba(43,37,64,0.82)"; roundRect(x, y, w, 16, 8); ctx.fill();
  const dot = { work: "#34c759", idle: "#ffb340", sleep: "#8e8e93" }[state];
  ctx.fillStyle = dot; ctx.beginPath(); ctx.arc(x + 7, y + 8, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(txt, sx + 3, y + 8);
  ctx.restore();
}
// Anneau de niveau + barre XP sous l'avatar
function drawProgressRing(sx, sy, prog) {
  if (!prog) return;
  const r = 8 * cam.zoom;
  ctx.save();
  ctx.lineWidth = Math.max(1.5, 2 * cam.zoom); ctx.strokeStyle = "rgba(124,108,255,0.2)";
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "#7c6cff"; ctx.beginPath();
  ctx.arc(sx, sy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog.levelPct); ctx.stroke();
  ctx.fillStyle = "#7c6cff"; ctx.beginPath(); ctx.arc(sx, sy, 6 * cam.zoom, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font = `700 ${Math.round(7 * cam.zoom)}px system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(prog.level), sx, sy + 0.5);
  ctx.restore();
}

// ===== Déplacements =====
// Au travail → uniquement vers la zone de travail. Sinon → errance aléatoire sur
// tout le monde, en évitant les tuiles d'objets solides et l'eau.
function isBlocked(gx, gy) {
  if (!inWorld(gx, gy)) return true;
  if (isSolidTile(gx, gy)) return true;
  const type = tileBiome(Math.round(gx), Math.round(gy));
  if (TILE_TYPES[type]?.solid) return true;
  return false;
}
function randomFreeTile() {
  const W = world();
  for (let i = 0; i < 12; i++) {
    // Centre de tuile = coordonnée entière (les tuiles sont centrées sur les entiers).
    const gx = Math.floor(Math.random() * W.w), gy = Math.floor(Math.random() * W.h);
    if (!isBlocked(gx, gy)) return { gx, gy };
  }
  return { gx: centroid.gx, gy: centroid.gy };
}
function findPath(from, to) {
  const W = world();
  const start = { x: clamp(Math.round(from.gx), 0, W.w - 1), y: clamp(Math.round(from.gy), 0, W.h - 1) };
  const goal = { x: clamp(Math.round(to.gx), 0, W.w - 1), y: clamp(Math.round(to.gy), 0, W.h - 1) };
  const gk = `${goal.x},${goal.y}`;
  const q = [start], seen = new Set([`${start.x},${start.y}`]), prev = new Map();
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  while (q.length) {
    const cur = q.shift();
    if (`${cur.x},${cur.y}` === gk) break;
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx, ny = cur.y + dy, k = `${nx},${ny}`;
      if (seen.has(k) || isBlocked(nx, ny)) continue;
      seen.add(k); prev.set(k, `${cur.x},${cur.y}`); q.push({ x: nx, y: ny });
    }
  }
  if (!seen.has(gk)) return [];
  const cells = [];
  let k = gk;
  while (k && k !== `${start.x},${start.y}`) {
    const [x, y] = k.split(",").map(Number);
    // Les tuiles sont dessinées CENTRÉES sur les coordonnées entières : on circule
    // donc au centre des cases (entiers), jamais sur les lignes de grille (x+0.5).
    cells.push({ gx: x, gy: y });
    k = prev.get(k);
  }
  return cells.reverse();
}
function pickTarget(p, r) {
  const st = deriveState(p.agent);
  if (st === "work") {
    // Alterne : une fois la station de travail, une fois une balade aléatoire sur
    // toute la zone — l'agent ne campe plus sur une coordonnée fixe.
    r.roam = !r.roam;
    if (r.roam) return randomWanderTarget(r);
    // Priorité : rejoindre l'objet spécial correspondant à la fonction utilisée.
    const taskTxt = taskCache.get(p.agent.id) || firstPendingTask(p.agent) || activityCache.get(p.agent.id) || "";
    const so = nearestSpecialObject(taskFn(taskTxt), r.pos);
    if (so) { const f = objectFootprint(so); return nearestFreeAround(f.x0 + Math.floor(f.w / 2), f.y0 + f.h); }
    const zt = zoneOf(classifyTask(p.agent));
    const off = (hash2(p.spawn.gx | 0, p.spawn.gy | 0) % 5) - 2;
    return nearestFreeAround(zt.gx + off * 0.5, zt.gy + 1 + (hash2(p.spawn.gy | 0, p.spawn.gx | 0) % 3) * 0.4);
  }
  // En veille (sleep) comme au repos (idle) : l'agent déambule librement sur toute
  // la carte via le pathfinding (collisions prises en compte), avec de longues
  // pauses de repos entre deux balades. Plus de point d'ancrage figé près du home
  // (qui faisait osciller l'agent entre deux tuiles voisines).
  return randomWanderTarget(r);
}
// Choisit une tuile libre suffisamment loin de la position courante ET reliée par
// un chemin (sinon l'agent « bougeait sur place »). Repli : n'importe quelle tuile.
function randomWanderTarget(r) {
  const from = r.pos;
  for (let i = 0; i < 8; i++) {
    const t = randomFreeTile();
    const manh = Math.abs(t.gx - from.gx) + Math.abs(t.gy - from.gy);
    if (manh < 5) continue;                         // assez loin pour une vraie balade
    if (findPath(from, t).length) return t;         // atteignable
  }
  return randomFreeTile();
}
function updateMovement(dt) {
  for (const p of placed) {
    const r = rt.get(p.agent.id); if (!r) continue;
    if (r.visit && r.visitTtl > 0) { r.visitTtl -= dt; }
    else if (r.visit) { r.visit = null; r.target = null; }
    if (r.pause > 0) { r.pause -= dt; continue; }
    if (!r.target) {
      const finalTarget = r.visit ? nearestFreeAround(r.visit.gx, r.visit.gy) : pickTarget(p, r);
      r.path = findPath(r.pos, finalTarget);
      // Destination injoignable : on attend un peu et on réessaiera (évite de
      // « vibrer » sur place en fonçant vers un point bloqué).
      if (!r.path.length && Math.hypot(finalTarget.gx - r.pos.gx, finalTarget.gy - r.pos.gy) > 0.6) {
        r.pause = 600; continue;
      }
      r.target = r.path.shift() || finalTarget;
    }
    const dx = r.target.gx - r.pos.gx, dy = r.target.gy - r.pos.gy;
    const d = Math.hypot(dx, dy);
    const tile = TILE_TYPES[tileBiome(Math.round(r.pos.gx), Math.round(r.pos.gy))] || TILE_TYPES.floor;
    const speed = 0.0015 * dt * (tile.speed || 1);
    if (d < 0.06) {
      r.pos = { ...r.target };
      r.target = r.path && r.path.length ? r.path.shift() : null;
      // Pause à l'arrivée : courte au travail, longue au repos (3–9 s) pour que la
      // balade alterne nettement déplacement et pause.
      r.pause = r.target ? 0 : ((deriveState(p.agent) === "work") ? 400 : 3000 + Math.random() * 6000);
      r.dir = r.dir || 1;
    } else {
      // Déplacement strictement ORTHOGONAL : on aligne d'abord l'axe X, puis
      // l'axe Y (jamais en diagonale). Les waypoints de findPath ne diffèrent
      // que sur un axe, donc l'alignement initial mis à part le mouvement suit
      // la grille en H/V uniquement.
      let nx = r.pos.gx, ny = r.pos.gy;
      let movedAxis = 0; // 1 = horizontal, 2 = vertical
      if (Math.abs(dx) > 0.001) { nx += Math.sign(dx) * Math.min(speed, Math.abs(dx)); movedAxis = 1; }
      else if (Math.abs(dy) > 0.001) { ny += Math.sign(dy) * Math.min(speed, Math.abs(dy)); movedAxis = 2; }
      // Évitement : si la prochaine tuile est bloquée, on abandonne la cible
      if (isBlocked(nx, ny)) { r.target = null; r.path = null; r.pause = 200; }
      else {
        r.pos.gx = nx; r.pos.gy = ny;
        if (movedAxis === 1) { r.dir = dx >= 0 ? 1 : -1; r.face = dx >= 0 ? "right" : "left"; }
        else if (movedAxis === 2) { r.face = dy >= 0 ? "down" : "up"; }  // gy croît vers le bas
        r.walkT = (r.walkT || 0) + dt;
      }
      
      // Spawne des étincelles/fumées sur la station active de travail de l'agent
      if (deriveState(p.agent) === "work" && Math.random() < 0.12) {
        const zt = zoneOf(classifyTask(p.agent));
        const s = worldToScreen(zt.gx, zt.gy);
        if (Math.random() < 0.4) {
          particles.push({
            x: s.x + (Math.random() - 0.5) * 20 * cam.zoom,
            y: s.y - 12 * cam.zoom,
            vx: (Math.random() - 0.5) * 0.8,
            vy: -Math.random() * 0.8 - 0.5,
            life: 0,
            max: 30 + Math.random() * 30,
            kind: "smoke",
            r: 2 * cam.zoom
          });
        } else {
          particles.push({
            x: s.x + (Math.random() - 0.5) * 24 * cam.zoom,
            y: s.y - 8 * cam.zoom,
            vx: (Math.random() - 0.5) * 1.5,
            vy: -Math.random() * 1.5 - 0.5,
            life: 0,
            max: 20 + Math.random() * 20,
            kind: "spark"
          });
        }
      }
    }
  }
}
// Déclenche une visite : un agent va rendre visite à un autre (échange inbox)
function triggerVisit(fromId, toId) {
  const r = rt.get(fromId); const dest = placed.find((p) => p.agent.id === toId);
  if (!r || !dest) return;
  // L'agent visité n'a plus de « home » : on vise sa position courante.
  const dr = rt.get(toId); const dpos = dr ? dr.pos : dest.spawn;
  r.visit = { gx: dpos.gx + 1.4, gy: dpos.gy + 1.4 };
  r.visitTtl = 6000; r.target = null; r.pause = 0;
  
  // Dialogues sympathiques
  const speeches = [
    "Hé ! Regarde mon nouveau script !",
    "Tu as vu mes stats de réussite ?",
    "Dis, tu veux qu'on collabore ?",
    "Je viens de finir une tâche !",
    "Sympa ton coin !",
    "Ça avance bien de ton côté ?",
    "Besoin d'aide pour une tâche ?",
    "Je fais une pause..."
  ];
  r.visitSpeech = speeches[Math.floor(Math.random() * speeches.length)];
  
  particles.push({ x: 0, y: 0, attach: fromId, kind: "heart", life: 0, max: 50 });
}

// ===== Particules =====
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const pa = particles[i]; pa.life += dt / 16;
    if (pa.kind === "smoke") { pa.x += pa.vx; pa.y += pa.vy; pa.r += 0.04; }
    if (pa.kind === "spark") { pa.x += pa.vx; pa.y += pa.vy; pa.vy += 0.04; }
    if (pa.life >= pa.max) particles.splice(i, 1);
  }
}
function drawParticles() {
  for (const pa of particles) {
    const k = 1 - pa.life / pa.max;
    if (pa.kind === "smoke") { ctx.fillStyle = `rgba(200,200,210,${0.35 * k})`; ctx.beginPath(); ctx.arc(pa.x, pa.y, pa.r, 0, Math.PI * 2); ctx.fill(); }
    else if (pa.kind === "spark") { ctx.fillStyle = `rgba(255,214,10,${k})`; ctx.fillRect(pa.x, pa.y, 3 * cam.zoom, 3 * cam.zoom); }
    else if (pa.kind === "heart") {
      const host = placed.find((p) => p.agent.id === pa.attach); if (!host) continue;
      const r = rt.get(pa.attach); const sc = worldToScreen(r.pos.gx, r.pos.gy);
      ctx.save(); ctx.globalAlpha = k; ctx.fillStyle = "#ff6f9d"; ctx.font = `${14 * cam.zoom}px system-ui`; ctx.textAlign = "center";
      ctx.fillText("♥", sc.x, sc.y - PH * SPRITE_SCALE * 0.5 * cam.zoom - (pa.life / pa.max) * 24); ctx.restore();
    }
  }
}
function spawnLevelUp(sx, sy) {
  for (let i = 0; i < 14; i++) particles.push({ x: sx, y: sy, vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 3 - 1, life: 0, max: 40, kind: "spark" });
}

function nightIntensity() {
  const p = dayPhase();
  if (p < 0.58 || p > 0.94) return 0;
  if (p >= 0.66 && p <= 0.86) return 1;
  if (p < 0.66) return (p - 0.58) / 0.08;
  return (0.94 - p) / 0.08;
}

function drawNightHalos() {
  const intensity = nightIntensity();
  if (intensity <= 0.01) return;
  
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = intensity * 0.38;
  const z = cam.zoom;

  // Halos des zones de travail actives
  for (const zn of layout.zones || []) {
    const active = placed.some(p => {
      const state = deriveState(p.agent);
      if (state !== "work") return false;
      const zt = zoneOf(classifyTask(p.agent));
      return zt.gx === zn.gx && zt.gy === zn.gy;
    });
    
    const s = worldToScreen(zn.gx, zn.gy);
    const radius = (active ? 78 : 52) * z;
    const grad = ctx.createRadialGradient(s.x, s.y, 2 * z, s.x, s.y, radius);
    if (active) {
      grad.addColorStop(0, "rgba(80, 220, 255, 0.95)");
      grad.addColorStop(0.3, "rgba(80, 180, 255, 0.45)");
      grad.addColorStop(1, "rgba(80, 180, 255, 0)");
    } else {
      grad.addColorStop(0, "rgba(124, 108, 255, 0.7)");
      grad.addColorStop(0.4, "rgba(124, 108, 255, 0.2)");
      grad.addColorStop(1, "rgba(124, 108, 255, 0)");
    }
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(s.x, s.y, radius, 0, Math.PI * 2); ctx.fill();
  }
  
  // Halos des agents actifs
  for (const p of placed) {
    const state = deriveState(p.agent);
    if (state !== "work") continue;
    const r = rt.get(p.agent.id);
    if (!r) continue;
    const s = worldToScreen(r.pos.gx, r.pos.gy);
    const radius = 32 * z;
    const grad = ctx.createRadialGradient(s.x, s.y, 1 * z, s.x, s.y, radius);
    grad.addColorStop(0, "rgba(255, 230, 150, 0.9)");
    grad.addColorStop(0.4, "rgba(255, 230, 150, 0.3)");
    grad.addColorStop(1, "rgba(255, 230, 150, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(s.x, s.y, radius, 0, Math.PI * 2); ctx.fill();
  }
  
  ctx.restore();
}

function drawPathTrail(p) {
  const r = rt.get(p.agent.id);
  if (!r || (!r.target && (!r.path || !r.path.length))) return;
  const z = cam.zoom;
  ctx.save();
  ctx.strokeStyle = p.agent.id === selectedId ? "rgba(124, 108, 255, 0.85)" : "rgba(124, 108, 255, 0.45)";
  ctx.lineWidth = 2.5 * z;
  ctx.setLineDash([4 * z, 4 * z]);
  ctx.lineDashOffset = - (Date.now() / 36) % 100;
  ctx.beginPath();
  const start = worldToScreen(r.pos.gx, r.pos.gy);
  ctx.moveTo(start.x, start.y);
  if (r.target) {
    const s = worldToScreen(r.target.gx, r.target.gy);
    ctx.lineTo(s.x, s.y);
  }
  if (r.path) {
    for (const node of r.path) {
      const s = worldToScreen(node.gx, node.gy);
      ctx.lineTo(s.x, s.y);
    }
  }
  ctx.stroke();
  
  const finalTarget = r.path && r.path.length ? r.path[r.path.length - 1] : r.target;
  if (finalTarget) {
    const s = worldToScreen(finalTarget.gx, finalTarget.gy);
    const pulse = 4.5 + 3 * Math.sin(Date.now() / 140);
    ctx.fillStyle = p.agent.id === selectedId ? "rgba(124, 108, 255, 0.9)" : "rgba(124, 108, 255, 0.5)";
    ctx.beginPath();
    ctx.arc(s.x, s.y, pulse * z, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ===== Boucle de rendu =====
let lastT = performance.now(), frameTick = 0;
function render(t) {
  const dt = Math.min(64, t - lastT); lastT = t;
  frameTick = Math.floor(t / 420);
  updateMovement(dt); updateParticles(dt);

  // Ciel
  const phase = dayPhase(); const sky = skyColors(phase);
  const grad = ctx.createLinearGradient(0, 0, 0, viewH);
  grad.addColorStop(0, sky.top); grad.addColorStop(1, sky.bot);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, viewW, viewH);
  // Étoiles la nuit
  if (isNight()) drawStars();

  const night = isNight();
  // Sol (cubes voxel)
  const b = groundBounds();
  for (let gy = b.y0; gy <= b.y1; gy++) for (let gx = b.x0; gx <= b.x1; gx++) {
    const s = worldToScreen(gx, gy);
    if (s.x < -TW * 2 || s.x > viewW + TW * 2 || s.y < -TH * 2 || s.y > viewH + TH * 2) continue;
    drawTile(s.x, s.y, gx, gy, night);
  }

  // Survol en mode construction : empreinte fantôme pour un pinceau asset,
  // sinon simple surbrillance de tuile (tiles/zones/sélection).
  if (editMode && hoverTile && buildAction === "paint" && isAssetBrush()) {
    drawPlacementGhost();
  } else if (editMode && hoverTile && (buildAction === "erase" || buildAction === "paint")) {
    const s = worldToScreen(Math.round(hoverTile.gx), Math.round(hoverTile.gy));
    const z = cam.zoom, w = TW * z, h = TH * z;
    ctx.save(); ctx.fillStyle = buildAction === "erase" ? "rgba(255,70,90,0.28)" : brush ? "rgba(124,108,255,0.35)" : "rgba(255,255,255,0.25)";
    ctx.fillRect(s.x - w / 2, s.y - h / 2, w, h);
    ctx.strokeStyle = "#fff"; ctx.strokeRect(s.x - w / 2 + 0.5, s.y - h / 2 + 0.5, w, h);
    ctx.restore();
  }

  // Tracés des chemins (trails) pour l'agent sélectionné/survolé
  for (const p of placed) {
    if (p.agent.id === selectedId || p.agent.id === hoverId) {
      drawPathTrail(p);
    }
  }

  // Entités triées en profondeur
  const ents = [];
  for (let gy = b.y0; gy <= b.y1; gy++) for (let gx = b.x0; gx <= b.x1; gx++) {
    const d = decorAt(gx, gy); if (d) ents.push({ depth: gx + gy, kind: "decor", d, gx, gy });
  }
  // Blocs agent (« objets agents ») en top layer, au-dessus des murs (layer 5).
  for (const z of layout.zones || []) ents.push({ depth: z.gx + z.gy + 0.35, layer: 6, kind: "zone", z });
  for (const o of layout.objects) ents.push({ depth: o.gx + o.gy + (o.layer === "wall" ? 0.85 : -0.18), layer: o.layer === "wall" ? 5 : 2, kind: "object", o });
  for (const p of placed) {
    const r = rt.get(p.agent.id); const pos = r ? r.pos : { gx: p.spawn.gx + 1, gy: p.spawn.gy + 1 };
    // Les agents passent au-dessus de tout le reste (plus de maison/home).
    ents.push({ depth: pos.gx + pos.gy, layer: 7, kind: "agent", p, pos });
  }
  ents.sort((a, c) => ((a.layer || 0) - (c.layer || 0)) || (a.depth - c.depth));

  for (const e of ents) {
    if (e.kind === "decor") { const s = worldToScreen(e.gx, e.gy); drawDecor(e.d, s.x, s.y, e.gx, e.gy); }
    else if (e.kind === "zone") drawZone(e.z);
    else if (e.kind === "object") drawObject(e.o);
    else if (e.kind === "agent") drawAgent(e.p, e.pos);
  }

  // Halos de lumière nocturnes
  drawNightHalos();

  drawParticles();

  // Vignette ambiante (renforcée la nuit) pour la profondeur
  const vig = ctx.createRadialGradient(viewW / 2, viewH / 2, Math.min(viewW, viewH) * 0.35, viewW / 2, viewH / 2, Math.max(viewW, viewH) * 0.75);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, night ? "rgba(10,12,30,0.42)" : "rgba(30,20,60,0.14)");
  ctx.fillStyle = vig; ctx.fillRect(0, 0, viewW, viewH);

  requestAnimationFrame(render);
}

let starSeed = null;
function drawStars() {
  if (!starSeed) { starSeed = []; for (let i = 0; i < 60; i++) starSeed.push([Math.random(), Math.random() * 0.5]); }
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  for (const [sx, sy] of starSeed) { const tw = 0.5 + 0.5 * Math.sin(Date.now() / 600 + sx * 30); ctx.globalAlpha = tw; ctx.fillRect(sx * viewW, sy * viewH, 2, 2); }
  ctx.globalAlpha = 1;
}

function drawAgent(p, pos) {
  const state = deriveState(p.agent);
  const r = rt.get(p.agent.id);
  const moving = r && r.target && !r.pause;
  const frame = moving ? (Math.floor((r.walkT || 0) / 160) % 2) : (frameTick % 2);
  const s = worldToScreen(pos.gx, pos.gy);
  const z = cam.zoom;
  const ap = appearanceOf(p.agent);
  const customImg = ap.assetId ? Assets.imageFor(ap.assetId) : null;
  const customAsset = ap.assetId ? Assets.getAsset(ap.assetId) : null;
  const useCustom = Assets.isReady(customImg);
  const dw = PW * SPRITE_SCALE * z, dh = PH * SPRITE_SCALE * z;
  const drawX = Math.round(s.x - dw / 2), drawY = Math.round(s.y - dh / 2);

  // Ombre stable topdown
  ctx.save(); ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath(); ctx.ellipse(s.x + 2 * z, s.y + 8 * z, 9 * z, 5 * z, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();

  if (p.agent.id === selectedId || p.agent.id === hoverId) {
    ctx.save(); ctx.strokeStyle = p.agent.id === selectedId ? "#7c6cff" : "rgba(124,108,255,0.5)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(s.x, s.y, 20 * z, 8 * z, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  // Style MetroCity (pack pixel topdown) : prioritaire si choisi et feuille prête.
  const useMetro = ap.style === "metrocity" && mcReady() && !useCustom;
  if (useMetro) {
    const mc = normalizeMc(ap, p.agent.id);
    const face = (r && r.face) || "down";
    const f = moving ? Math.floor((r.walkT || 0) / 140) % 6 : 0;
    const spr = mcSprite({ skin: mc.mcSkin, outfit: mc.mcOutfit, hair: mc.mcHair, dir: face, frame: f });
    if (spr) {
      const mw = MC_FRAME * MC_SCALE * z, mh = MC_FRAME * MC_SCALE * z;
      const mx = Math.round(s.x - mw / 2), my = Math.round(s.y + 8 * z - mh); // pieds ≈ tuile
      ctx.drawImage(spr, mx, my, mw, mh);
    }
  } else if (useCustom) {
    if (customAsset?.kind === "spritesheet") {
      const cols = 4, rows = Math.max(1, Math.round(customImg.naturalHeight / Math.max(1, customImg.naturalWidth / cols)));
      const sw = Math.floor(customImg.naturalWidth / cols), sh = Math.floor(customImg.naturalHeight / rows);
      const f = moving ? Math.floor((r.walkT || 0) / 140) % cols : frameTick % cols;
      const row = state === "work" && rows > 1 ? 1 : state === "sleep" && rows > 2 ? 2 : 0;
      ctx.drawImage(customImg, f * sw, Math.min(row, rows - 1) * sh, sw, sh, drawX, drawY, dw, dh);
    } else {
      const ar = customImg.naturalWidth / customImg.naturalHeight;
      let iw = dw, ih = dw / ar; if (ih > dh * 1.1) { ih = dh * 1.1; iw = ih * ar; }
      const ix = Math.round(s.x - iw / 2), iy = Math.round(s.y - ih / 2);
      if (r && r.dir === -1) { ctx.save(); ctx.translate(s.x, 0); ctx.scale(-1, 1); ctx.drawImage(customImg, -(s.x - ix) - iw, iy, iw, ih); ctx.restore(); }
      else ctx.drawImage(customImg, ix, iy, iw, ih);
    }
  } else {
    // En déplacement, un agent en veille marche les yeux ouverts (pose idle).
    const sprite = spriteFor(p.agent, moving && state === "sleep" ? "idle" : state, frame, moving);
    if (r && r.dir === -1) { ctx.save(); ctx.translate(s.x, 0); ctx.scale(-1, 1); ctx.drawImage(sprite, -(s.x - drawX) - dw, drawY, dw, dh); ctx.restore(); }
    else ctx.drawImage(sprite, drawX, drawY, dw, dh);
  }

  p._box = { x: drawX + 8 * z, y: drawY + 4 * z, w: dw - 16 * z, h: dh - 8 * z };

  // Anneau de niveau
  drawProgressRing(s.x + 12 * z, s.y - 12 * z, progressCache.get(p.agent.id));

  // Bulle / état
  if (r && r.visit && r.visitSpeech && (!r.target || Math.hypot(r.pos.gx - r.visit.gx, r.pos.gy - r.visit.gy) < 0.25)) {
    drawBubble(s.x, drawY - 4 * z, r.visitSpeech, "#ffd60a");
  } else if (state === "work") {
    const running = runningAgents.has(p.agent.id);
    const act = activityCache.get(p.agent.id) || taskCache.get(p.agent.id) || firstPendingTask(p.agent) || "travaille…";
    // Agent réellement en cours : bulle stable et préfixée (indication claire) ;
    // sinon (tâche en file) on garde le clignotement discret.
    if (running) drawBubble(s.x, drawY - 4 * z, "⚙ " + act, "#7c6cff");
    else if (frameTick % 2 === 0) drawBubble(s.x, drawY - 4 * z, act, "#7c6cff");
  } else if (state === "sleep" && !moving) {
    // « Zzz » uniquement à l'arrêt (l'agent en veille déambule puis se repose).
    ctx.save(); ctx.font = `italic ${13 * z}px system-ui`; ctx.fillStyle = "rgba(43,37,64,0.5)"; ctx.textAlign = "center";
    ctx.fillText(frameTick % 2 ? "z Z" : "Z z", s.x + 12 * z, drawY + 4 * z); ctx.restore();
  }
}

// ===== Redimensionnement =====
function resize() {
  dpr = window.devicePixelRatio || 1;
  viewW = window.innerWidth; viewH = window.innerHeight;
  canvas.width = viewW * dpr; canvas.height = viewH * dpr;
  canvas.style.width = viewW + "px"; canvas.style.height = viewH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
}

// ===== Interaction : pan + zoom + clic (+ construction) =====
let dragging = false, dragMoved = false, lastX = 0, lastY = 0, pointerStartedOnUi = false;
function isUiTarget(target) {
  return !!target?.closest?.(".hud-top, .hud-tools, .build-dock, .special-card, .modal-overlay, .card, button, input, select, textarea, label");
}
function activeBuildField() {
  const el = document.activeElement;
  return !!el?.closest?.("#build-dock");
}
window.addEventListener("mousedown", (e) => {
  pointerStartedOnUi = isUiTarget(e.target);
}, true);
canvas.addEventListener("mousedown", (e) => {
  if (isUiTarget(e.target)) return;
  dragMoved = false; lastX = e.clientX; lastY = e.clientY;
  if (editMode) {
    if (buildAction === "paint" || buildAction === "erase") return; // action au mouseup
    if (buildAction === "select") {
      // Sélection / déplacement d'un objet ou d'un bloc agent
      const zn = zoneAtScreen(e.clientX, e.clientY);
      if (zn) { selectedObj = zn; draggingObj = { kind: "zone", ref: zn }; renderBuildSel(); return; }
      const obj = objectAtScreen(e.clientX, e.clientY);
      if (obj) { selectedObj = obj; draggingObj = { kind: "obj", ref: obj }; renderBuildSel(); return; }
      selectedObj = null; renderBuildSel();
    }
    // buildAction === "pan" : on laisse glisser le canevas (fall-through)
  }
  dragging = true;
});
window.addEventListener("mouseup", (e) => {
  const endedOnUi = isUiTarget(e.target);
  if (editMode && !dragMoved && !pointerStartedOnUi && !endedOnUi) {
    if (buildAction === "erase") eraseAt(e.clientX, e.clientY);
    else if (buildAction === "paint" && isPaintBrush()) placeBrush(e.clientX, e.clientY);
  }
  if (draggingObj) { scheduleSave(); draggingObj = null; }
  dragging = false;
  pointerStartedOnUi = false;
});
window.addEventListener("mousemove", (e) => {
  if (isUiTarget(e.target) && !dragging && !draggingObj) return;
  if (editMode) hoverTile = tileAtScreen(e.clientX, e.clientY);
  if (draggingObj) {
    const t = tileAtScreen(e.clientX, e.clientY); dragMoved = true;
    const gx = clamp(t.gx, 0, world().w - 1), gy = clamp(t.gy, 0, world().h - 1);
    if (draggingObj.kind === "obj") { draggingObj.ref.gx = gx; draggingObj.ref.gy = gy; }
    else if (draggingObj.kind === "zone") { draggingObj.ref.gx = Math.round(gx); draggingObj.ref.gy = Math.round(gy); if (draggingObj.ref.type === "workshop") atelier = { gx: draggingObj.ref.gx, gy: draggingObj.ref.gy }; }
    return;
  }
  if (dragging) { const dx = e.clientX - lastX, dy = e.clientY - lastY; if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true; cam.x += dx; cam.y += dy; lastX = e.clientX; lastY = e.clientY; }
  else {
    hoverId = editMode ? null : agentAt(e.clientX, e.clientY);
    if (editMode && buildAction === "select") canvas.style.cursor = zoneAtScreen(e.clientX, e.clientY) || objectAtScreen(e.clientX, e.clientY) ? "pointer" : "default";
    else canvas.style.cursor = editMode ? (buildAction === "paint" ? "copy" : buildAction === "erase" ? "not-allowed" : "grab") : (hoverId || zoneAtScreen(e.clientX, e.clientY) ? "pointer" : "grab");
  }
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  cam.zoom = clamp(cam.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.45, 2.6);
}, { passive: false });
canvas.addEventListener("click", (e) => {
  if (dragMoved || editMode) return;
  const id = agentAt(e.clientX, e.clientY);
  if (id) { selectedId = id; openCard(id); return; }
  const zn = zoneAtScreen(e.clientX, e.clientY);
  if (zn) { openSpecialCard(ensureZoneSpecial(zn)); return; }
  const obj = objectAtScreen(e.clientX, e.clientY);
  if (obj?.special) { openSpecialCard(obj); return; }
  selectedId = null; closeCard();
});
window.addEventListener("keydown", (e) => {
  if (!editMode) return;
  if (isUiTarget(e.target)) return;
  if ((e.key === "Delete" || e.key === "Backspace") && selectedObj) {
    if (selectedObj.assetId || selectedObj.layer === "wall") layout.objects = layout.objects.filter((o) => o !== selectedObj);
    else if (selectedObj.type) layout.zones = layout.zones.filter((z) => z !== selectedObj);
    selectedObj = null; scheduleSave(); renderBuildSel();
  }
});

// Pose un élément sur la tuile cliquée selon la config courante (brushCfg +
// pendingFootprint). Type : object | special | decor | wall | floor | zone.
function placeBrush(mx, my) {
  const t = tileAtScreen(mx, my);
  const gx = clamp(Math.round(t.gx), 0, world().w - 1), gy = clamp(Math.round(t.gy), 0, world().h - 1);
  const type = brushCfg.type;
  // Bloc agent : place / déplace la zone du type choisi.
  if (type === "zone" || brush?.type === "zone") {
    const zt = brush?.type === "zone" ? brush.id : (brushCfg.zoneType || "tools");
    layout.zones = Array.isArray(layout.zones) ? layout.zones : [];
    layout.zonesInitialized = true;
    normalizeZones();
    const existing = layout.zones.find((z) => z.type === zt);
    const z = existing || { id: `z-${zt}-${Date.now()}`, type: zt, gx, gy, gridW: pendingFootprint.w, gridH: pendingFootprint.h, scale: pendingFootprint.scale || 1 };
    z.gx = gx; z.gy = gy;
    z.gridW = pendingFootprint.w;
    z.gridH = pendingFootprint.h;
    z.scale = pendingFootprint.scale || 1;
    if (!existing) layout.zones.push(z);
    if (z.type === "tools") { layout.workZone = { gx, gy }; atelier = { gx, gy }; }
    selectedObj = z; scheduleSave(); renderBuildSel();
    return;
  }
  if (!brush || !brush.id) return; // les autres types réclament un asset (sprite)
  // Sol : override de tuile par case.
  if (type === "floor") {
    setTile(gx, gy, { type: "floor", assetId: brush.id });
    selectedObj = null; scheduleSave(); renderBuildSel();
    return;
  }
  // Objet / mur / déco / spécial : élément placé.
  const layer = type === "wall" ? "wall" : (pendingFootprint.layer === "wall" ? "wall" : "object");
  const o = {
    id: `o-${Date.now()}-${layout.objects.length}`,
    assetId: brush.id, layer, gx, gy,
    scale: pendingFootprint.scale || 1, gridW: pendingFootprint.w, gridH: pendingFootprint.h,
    solid: !!pendingFootprint.solid, customized: true,
  };
  if (type === "special") o.special = { fn: brushCfg.fn, config: brushCfg.fnConfig };
  if (type === "decor") o.decorative = true;
  layout.objects.push(o);
  selectedObj = o; scheduleSave(); renderBuildSel();
}
function placeWorkzone(mx, my) {
  const t = tileAtScreen(mx, my);
  const gx = clamp(Math.round(t.gx), 0, world().w - 1), gy = clamp(Math.round(t.gy), 0, world().h - 1);
  const z = zoneOf("tools"); z.gx = gx; z.gy = gy; layout.workZone = { gx, gy }; atelier = { gx, gy }; scheduleSave();
}
function clearBrush(mx, my) {
  const t = tileAtScreen(mx, my);
  const gx = clamp(Math.round(t.gx), 0, world().w - 1), gy = clamp(Math.round(t.gy), 0, world().h - 1);
  if (clearTileAt(gx, gy)) { selectedObj = null; scheduleSave(); renderBuildSel(); }
}
// Gomme : supprime l'élément cliqué (objet, mur, bloc agent), sinon la tuile/décor.
function eraseAt(mx, my) {
  const zn = zoneAtScreen(mx, my);
  if (zn) { layout.zones = (layout.zones || []).filter((z) => z !== zn); selectedObj = null; scheduleSave(); renderBuildSel(); return; }
  const obj = objectAtScreen(mx, my);
  if (obj) { layout.objects = layout.objects.filter((o) => o !== obj); selectedObj = null; scheduleSave(); renderBuildSel(); return; }
  clearBrush(mx, my);
}
// Vide intégralement la map (objets, murs, blocs agent, tuiles peintes).
async function clearCanvas() {
  const ok = await confirmDialog("Nettoyer le canevas", "Supprimer TOUS les éléments de la map (objets, murs, blocs agent, sols peints) ? Cette action est irréversible.");
  if (!ok) return;
  layout.objects = []; layout.zones = []; layout.tiles = {};
  layout.zonesInitialized = true;
  selectedObj = null; brush = null;
  scheduleSave(); renderBuildSel(); if (editMode) renderBuildGrid();
}
// confirm() natif inopérant sous Tauri/WKWebView : on construit notre propre
// boîte de dialogue modale (Promise<boolean>).
function confirmDialog(title, message) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "modal-overlay confirm-overlay";
    ov.innerHTML = `<div class="confirm-box">
      <p class="confirm-title">${escapeHtml(title)}</p>
      <p class="confirm-msg">${escapeHtml(message)}</p>
      <div class="confirm-actions">
        <button class="card-btn" data-act="no">Annuler</button>
        <button class="card-btn danger" data-act="yes">Confirmer</button>
      </div></div>`;
    const done = (v) => { ov.remove(); resolve(v); };
    ov.addEventListener("click", (e) => {
      if (e.target === ov || e.target.dataset.act === "no") done(false);
      else if (e.target.dataset.act === "yes") done(true);
    });
    document.body.appendChild(ov);
  });
}
function agentAt(mx, my) {
  for (let i = placed.length - 1; i >= 0; i--) { const bx = placed[i]._box; if (bx && mx >= bx.x && mx <= bx.x + bx.w && my >= bx.y && my <= bx.y + bx.h) return placed[i].agent.id; }
  return null;
}

// ===== Panneau d'infos (onglets Infos / Mémoire) =====
function findAgent(id) { return agents.find((a) => a.id === id); }
function openCard(id) {
  const agent = findAgent(id); if (!agent) return;
  $("#card").hidden = false; $("#card").dataset.agentId = id;
  renderCard(agent);
  refreshActivity(id);

  // Populate social interaction dropdown
  const socialTargetSel = $("#card-social-target");
  if (socialTargetSel) {
    socialTargetSel.innerHTML = "";
    const otherAgents = agents.filter(a => a.id !== id);
    for (const other of otherAgents) {
      const opt = document.createElement("option");
      opt.value = other.id;
      opt.textContent = other.name || "Sans nom";
      socialTargetSel.appendChild(opt);
    }
    if (!otherAgents.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Aucun autre agent";
      socialTargetSel.appendChild(opt);
    }
  }
}
function renderCard(agent) {
  const state = deriveState(agent);
  const prog = progressCache.get(agent.id);
  $("#card-name").textContent = agent.name || "Sans nom";
  const stateEl = $("#card-state"); stateEl.className = "card-state " + state;
  stateEl.textContent = { work: "● Au travail", idle: "● Au repos", sleep: "● En veille" }[state];
  const av = $("#card-avatar");
  const apc = appearanceOf(agent);
  let avatarUrl;
  if (apc.style === "metrocity" && mcReady()) {
    const mc = normalizeMc(apc, agent.id);
    const spr = mcSprite({ skin: mc.mcSkin, outfit: mc.mcOutfit, hair: mc.mcHair, dir: "down", frame: 0 });
    avatarUrl = spr ? spr.toDataURL() : spriteFor(agent, state, 0).toDataURL();
  } else {
    avatarUrl = spriteFor(agent, state, 0).toDataURL();
  }
  av.style.backgroundImage = `url(${avatarUrl})`;
  av.style.backgroundSize = "contain"; av.style.backgroundRepeat = "no-repeat"; av.style.backgroundPosition = "center";
  // Bandeau niveau
  if (prog) {
    $("#card-level").innerHTML =
      `<div class="lvl-row"><span class="lvl-badge">N${prog.level}</span><span class="lvl-title">${escapeHtml(prog.title)}</span><span class="lvl-xp">${prog.xpIntoLevel}/${prog.xpForNext} XP</span></div>` +
      `<div class="lvl-bar"><i style="width:${Math.round(prog.levelPct * 100)}%"></i></div>` +
      `<div class="lvl-stats">${prog.successes}✓ · ${prog.failures}✕ · ${prog.successRate}% réussite${prog.bestStreak > 1 ? ` · série ${prog.bestStreak}` : ""}</div>` +
      (prog.badges.length ? `<div class="lvl-badges">${prog.badges.map((b) => `<span class="bdg" title="${escapeHtml(b.desc)}">${b.icon} ${escapeHtml(b.label)}</span>`).join("")}</div>` : "");
  } else $("#card-level").innerHTML = "";
  // Onglets
  renderTab(agent);
}
function renderTab(agent) {
  $("#tab-info").classList.toggle("active", cardTab === "info");
  $("#tab-mem").classList.toggle("active", cardTab === "mem");
  if (cardTab === "info") { $("#pane-info").hidden = false; $("#pane-mem").hidden = true; renderInfo(agent); }
  else { $("#pane-info").hidden = true; $("#pane-mem").hidden = false; renderMemory(agent); }
}
function renderInfo(agent) {
  $("#card-activity").textContent = activityCache.get(agent.id) || firstPendingTask(agent) || "Aucune activité récente.";
  const wrap = $("#card-tasks"); const tasks = agent.tasks || [];
  if (!tasks.length) { wrap.innerHTML = `<span class="hint">Aucune tâche.</span>`; return; }
  const now = Math.floor(Date.now() / 1000);
  wrap.innerHTML = tasks.slice(0, 6).map((t) => {
    const done = t.done ? " done" : "";
    const due = t.due ? `<span class="due">${t.due > now ? "🔒 " : ""}${new Date(t.due * 1000).toLocaleDateString()}</span>` : "";
    return `<div class="card-task${done}"><span>${t.done ? "✓" : "○"}</span><span>${escapeHtml(t.text)}</span>${due}</div>`;
  }).join("");
}
function renderMemory(agent) {
  // Journal dérivé (succès/échecs récents)
  const act = window.__activityFull?.get(agent.id) || [];
  const reports = act.filter((e) => e.kind === "report").slice(-8).reverse();
  const journal = reports.length
    ? reports.map((e) => `<div class="jr ${e.success ? "ok" : "ko"}"><span>${e.success ? "✓" : "✕"}</span><span>${escapeHtml((e.task || "").slice(0, 60))}</span></div>`).join("")
    : `<span class="hint">Pas encore d'historique.</span>`;
  const mem = agent.memory && agent.memory.lessons ? agent.memory.lessons : "";
  const learnOn = !!agent.learning_enabled;
  $("#pane-mem").innerHTML =
    `<div class="card-section"><span class="card-label">Journal récent</span><div class="journal">${journal}</div></div>` +
    `<div class="card-section"><span class="card-label">Leçons distillées ${learnOn ? '<em class="on">apprentissage actif</em>' : '<em class="off">passif</em>'}</span>` +
    `<div class="lessons">${mem ? escapeHtml(mem).replace(/\n/g, "<br>") : '<span class="hint">Aucune leçon. Clique « Méditer » pour en générer depuis l\'historique.</span>'}</div></div>` +
    `<div class="card-actions"><button class="card-btn primary" id="mem-distill">🧘 Méditer (distiller)</button></div>` +
    `<p class="card-feedback" id="mem-feedback"></p>`;
  $("#mem-distill").addEventListener("click", () => distill(agent.id));
}

function closeCard() { $("#card").hidden = true; }

async function refreshActivity(id) {
  if (!invoke) return;
  try {
    const entries = await invoke("agent_activity", { id });
    window.__activityFull = window.__activityFull || new Map();
    window.__activityFull.set(id, entries || []);
    const steps = (entries || []).filter((p) => p.kind === "step");
    const last = steps[steps.length - 1] || (entries || [])[(entries || []).length - 1];
    const txt = last ? (last.text || last.output || last.summary || "") : "";
    if (txt) { activityCache.set(id, txt); if ($("#card").dataset.agentId === id && cardTab === "info") $("#card-activity").textContent = txt; }
    // Met à jour la progression
    progressCache.set(id, computeProgress(entries || []));
  } catch {}
}

async function distill(id) {
  const fb = $("#mem-feedback"); if (!invoke) { if (fb) fb.textContent = "Indisponible hors application."; return; }
  if (fb) fb.textContent = "Distillation en cours… (appel au modèle)";
  try { await invoke("agent_distill_memory", { id }); if (fb) fb.textContent = "Mémoire mise à jour ✓"; await loadAgents(); if (selectedId === id) renderCard(findAgent(id)); }
  catch (e) { if (fb) fb.textContent = "Échec : " + (e?.message || e); }
}

// Actions panneau
$("#card-close").addEventListener("click", () => { selectedId = null; closeCard(); });
$("#tab-info").addEventListener("click", () => { cardTab = "info"; const a = findAgent($("#card").dataset.agentId); if (a) renderTab(a); });
$("#tab-mem").addEventListener("click", () => { cardTab = "mem"; const a = findAgent($("#card").dataset.agentId); if (a) renderTab(a); });
$("#card-run").addEventListener("click", async () => {
  const id = $("#card").dataset.agentId; if (!id || !invoke) return;
  setFeedback("Lancement…");
  try { await invoke("agent_run_now", { id }); setFeedback("Agent lancé ✓"); } catch (e) { setFeedback("Échec : " + (e?.message || e)); }
});
$("#card-assign").addEventListener("click", assignTask);
$("#card-taskinput").addEventListener("keydown", (e) => { if (e.key === "Enter") assignTask(); });
async function assignTask() {
  const id = $("#card").dataset.agentId; if (!id || !invoke) return;
  const input = $("#card-taskinput"); const text = input.value.trim(); if (!text) return;
  const agent = findAgent(id); if (!agent) return;
  const clone = structuredClone(agent); clone.tasks = clone.tasks || [];
  clone.tasks.push({ id: `t-${Date.now()}`, text, done: false, due: null });
  setFeedback("Enregistrement…");
  try { await invoke("agent_save", { agent: clone }); input.value = ""; setFeedback("Tâche assignée ✓"); agent.tasks = clone.tasks; if (cardTab === "info") renderInfo(agent); }
  catch (e) { setFeedback("Échec : " + (e?.message || e)); }
}
$("#card-open").addEventListener("click", () => {
  const opener = window.parent && window.parent.__lumenOpenApp;
  if (opener) opener("agents"); else setFeedback("Ouvre l'app Agents manuellement.");
});
function setFeedback(msg) { const el = $("#card-feedback"); if (el) el.textContent = msg; }

// ===== Chargement des données =====
async function loadAgents() {
  if (!invoke) agents = [];
  else { try { agents = await invoke("agent_list"); } catch { agents = []; } }
  agents = agents || [];
  await Assets.loadAssets(invoke);
  hydrateObjectFootprintsFromAssets();
  $("#empty").hidden = agents.length > 0;
  $("#hud-count").textContent = agents.length ? `${agents.length} agent${agents.length > 1 ? "s" : ""}` : "";
  // Compteurs d'état du HUD (au travail / au repos / en veille)
  { let w = 0, i = 0, s = 0;
    for (const a of agents) { const st = deriveState(a); if (st === "work") w++; else if (st === "idle") i++; else s++; }
    const setStat = (id, n) => { const el = $(id); if (el) el.textContent = String(n); };
    setStat("#stat-work", w); setStat("#stat-idle", i); setStat("#stat-sleep", s); }
  // Progression de tous les agents (depuis l'activité)
  window.__activityFull = window.__activityFull || new Map();
  await Promise.all(agents.map(async (a) => {
    if (!invoke) return;
    try {
      const entries = await invoke("agent_activity", { id: a.id });
      window.__activityFull.set(a.id, entries || []);
      const prevLvl = progressCache.get(a.id)?.level || 1;
      const prog = computeProgress(entries || []);
      progressCache.set(a.id, prog);
      if (prog.level > prevLvl && rt.has(a.id)) { const r = rt.get(a.id); const s = worldToScreen(r.pos.gx, r.pos.gy); spawnLevelUp(s.x, s.y); }
    } catch {}
  }));
  relayout();
  if (selectedId && findAgent(selectedId)) renderCard(findAgent(selectedId));
  else if (selectedId) { selectedId = null; closeCard(); }
}

// ===== Contrôles HUD (zoom) =====
function zoomAround(factor) {
  cam.zoom = clamp(cam.zoom * factor, 0.5, 2.4);
}
$("#zoom-in")?.addEventListener("click", () => zoomAround(1.2));
$("#zoom-out")?.addEventListener("click", () => zoomAround(1 / 1.2));
$("#zoom-reset")?.addEventListener("click", () => { cam.x = 0; cam.y = 0; cam.zoom = 1; });

// Plein écran (écran dédié) — privilégie l'API fenêtre Tauri, repli sur l'API DOM.
$("#toggle-fullscreen")?.addEventListener("click", async () => {
  try {
    const w = window.__TAURI__?.window?.getCurrentWindow?.();
    if (w) { const on = await w.isFullscreen(); await w.setFullscreen(!on); return; }
  } catch {}
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {}
});

// ===== Panneau de construction (dock latéral) =====
// Un seul panneau : outils en haut, configuration à gauche, assets (filtrés par
// catégorie) à droite. On choisit un Type + les réglages, on sélectionne un
// asset, puis on dessine sur la scène pour poser selon cette configuration.
const FN_META = {
  image: { icon: "🖼️", label: "Image (génération)", action: "Générer", placeholder: "Décris l'image à générer…" },
  text: { icon: "📝", label: "Texte (génération)", action: "Rédiger", placeholder: "Sujet du texte à rédiger…" },
  tool: { icon: "🛠️", label: "Tool", action: "Lancer", placeholder: "Décris la tâche / le tool…" },
};
// Compose un texte de tâche dont les mots-clés routent l'agent vers cet objet.
function composeTask(fn, prompt) {
  const p = (prompt || "").trim();
  if (!p) return "";
  if (fn === "image") return `Génère une image : ${p}`;
  if (fn === "text") return `Rédige un texte : ${p}`;
  return p;
}

function initDock() {
  $("#toggle-build")?.addEventListener("click", () => setEditMode(!editMode));
  $("#dock-close")?.addEventListener("click", () => setEditMode(false));
  $("#dock-clear")?.addEventListener("click", () => clearCanvas());

  // Sous-select « Bloc agent » (types de zones).
  const zoneSel = $("#cfg-zone");
  if (zoneSel && !zoneSel.options.length) {
    for (const [id, z] of Object.entries(ZONE_TYPES)) zoneSel.appendChild(new Option(z.label, id));
    zoneSel.value = brushCfg.zoneType;
  }

  // Type de pose.
  $("#cfg-type")?.addEventListener("change", (e) => setBrushType(e.target.value));
  $("#cfg-zone")?.addEventListener("change", (e) => {
    brushCfg.zoneType = e.target.value;
    if (selectedObj?.type) { moveZoneType(selectedObj, e.target.value); }
    else { brush = { type: "zone", id: e.target.value }; buildAction = "paint"; selectedObj = null; }
    renderBuildSel(); updateBuildToolStates();
  });

  // Objet spécial : fonction IA + config.
  $("#cfg-fn")?.addEventListener("change", (e) => {
    if (selectedObj?.special) { selectedObj.special.fn = e.target.value; selectedObj.customized = true; scheduleSave(); }
    else brushCfg.fn = e.target.value;
  });
  $("#cfg-fn-config")?.addEventListener("input", (e) => {
    if (selectedObj?.special) { selectedObj.special.config = e.target.value; selectedObj.customized = true; scheduleSave(); }
    else brushCfg.fnConfig = e.target.value;
  });

  // Collision.
  $("#cfg-solid")?.addEventListener("change", (e) => {
    if (selectedObj && !selectedObj.type) { selectedObj.solid = !!e.target.checked; selectedObj.customized = true; scheduleSave(); }
    else pendingFootprint.solid = !!e.target.checked;
  });
  // Layer.
  $("#cfg-layer")?.addEventListener("change", (e) => {
    const layer = e.target.value === "wall" ? "wall" : "object";
    if (selectedObj?.assetId) { selectedObj.layer = layer; selectedObj.customized = true; scheduleSave(); }
    else pendingFootprint.layer = layer;
    renderBuildSel();
  });
  // Sol par défaut (habille tout le sol non peint avec l'asset courant).
  $("#cfg-floor-default")?.addEventListener("change", (e) => {
    if (!brush?.id) return;
    layout.assets = layout.assets || {};
    if (e.target.checked) layout.assets["tile:floor"] = { assetId: brush.id };
    else delete layout.assets["tile:floor"];
    scheduleSave();
  });

  // Taille : échelle + emprise (objet sélectionné, sinon prochain objet posé).
  const applyScale = (e) => {
    const v = clamp(parseFloat(e.target.value) || 1, 0.4, 1.4);
    if (selectedObj) { selectedObj.scale = v; selectedObj.customized = true; scheduleSave(); }
    else { pendingFootprint.scale = v; if (brush?.id) saveBrushFootprintDefault(); }
  };
  $("#cfg-scale")?.addEventListener("input", applyScale);
  $("#cfg-scale")?.addEventListener("change", applyScale);
  const applyW = (e) => {
    const v = clamp(parseInt(e.target.value || "1", 10), 1, 6);
    if (selectedObj) { selectedObj.gridW = v; selectedObj.customized = true; scheduleSave(); }
    else { pendingFootprint.w = v; if (brush?.id) saveBrushFootprintDefault(); }
  };
  $("#cfg-w")?.addEventListener("input", applyW);
  $("#cfg-w")?.addEventListener("change", applyW);
  const applyH = (e) => {
    const v = clamp(parseInt(e.target.value || "1", 10), 1, 6);
    if (selectedObj) { selectedObj.gridH = v; selectedObj.customized = true; scheduleSave(); }
    else { pendingFootprint.h = v; if (brush?.id) saveBrushFootprintDefault(); }
  };
  $("#cfg-h")?.addEventListener("input", applyH);
  $("#cfg-h")?.addEventListener("change", applyH);

  // Élément sélectionné : retirer / réinitialiser le skin d'un bloc.
  $("#cfg-delete")?.addEventListener("click", () => {
    if (!selectedObj) return;
    if (selectedObj.type) layout.zones = layout.zones.filter((z) => z !== selectedObj);
    else layout.objects = layout.objects.filter((o) => o !== selectedObj);
    selectedObj = null; scheduleSave(); renderBuildSel();
  });
  $("#cfg-skin-clear")?.addEventListener("click", () => {
    if (selectedObj?.type) setZoneSkin(selectedObj.type, "");
  });

  // Import + catégorie + glisser-déposer.
  $("#dock-import")?.addEventListener("click", () => $("#asset-file").click());
  $("#asset-file")?.addEventListener("change", onAssetFile);
  $("#dock-category")?.addEventListener("change", () => renderBuildGrid());
  const dropZone = $("#drag-drop-zone");
  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", async (e) => { e.preventDefault(); dropZone.classList.remove("dragover"); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) uploadAssetFile(f); });
    dropZone.addEventListener("click", () => $("#asset-file").click());
  }

  // Outils du haut (main / sélection / gomme).
  document.querySelectorAll(".dock-tool[data-brush]").forEach((btn) => {
    btn.addEventListener("click", () => {
      buildAction = btn.dataset.brush;
      brush = null; selectedObj = null;
      renderBuildSel(); updateBuildToolStates();
    });
  });

  // Fiche « objet spécial » (clic hors édition).
  $("#special-close")?.addEventListener("click", () => { $("#special-card").hidden = true; openSpecialObj = null; });
  $("#special-run")?.addEventListener("click", () => triggerSpecialTask(false));
  $("#special-run-now")?.addEventListener("click", () => triggerSpecialTask(true));

  // Interaction sociale (fiche agent).
  $("#card-social-visit")?.addEventListener("click", () => {
    const fromId = $("#card").dataset.agentId;
    const toId = $("#card-social-target")?.value;
    if (fromId && toId) { triggerVisit(fromId, toId); setFeedback("Visite programmée ✓"); }
  });
}

// Applique les défauts de layer/collision d'un type, et arme le pinceau adéquat.
function setBrushType(type) {
  brushCfg.type = type;
  const defs = {
    object: { layer: "object", solid: true },
    special: { layer: "object", solid: false },
    decor: { layer: "object", solid: false },
    wall: { layer: "wall", solid: true },
    floor: { layer: "floor", solid: false },
    zone: { layer: "object", solid: false },
  }[type] || { layer: "object", solid: true };
  pendingFootprint.layer = defs.layer;
  pendingFootprint.solid = defs.solid;
  if (type === "zone") {
    brush = { type: "zone", id: brushCfg.zoneType || "tools" };
    buildAction = "paint"; selectedObj = null;
  } else if (brush?.type === "zone") {
    brush = null; // le pinceau bloc ne s'applique plus : il faut choisir un asset
  }
  renderBuildSel(); updateBuildToolStates();
}

// Change le type d'un bloc agent déjà posé (conserve sa position).
function moveZoneType(zone, newType) {
  if (!zone || zone.type === newType) return;
  const other = layout.zones.find((z) => z.type === newType && z !== zone);
  if (other) {
    other.gx = zone.gx; other.gy = zone.gy;
    other.gridW = zone.gridW || other.gridW;
    other.gridH = zone.gridH || other.gridH;
    other.scale = zone.scale || other.scale;
    other.customized = true;
    layout.zones = layout.zones.filter((z) => z !== zone);
    selectedObj = other;
  }
  else zone.type = newType;
  scheduleSave();
}

// Écrit/efface le skin (image) d'un type de bloc agent.
function setZoneSkin(type, assetId) {
  layout.assets = layout.assets || {};
  const key = `zone:${type}`;
  const zone = (layout.zones || []).find((z) => z.type === type);
  if (zone) {
    const current = zoneFootprint(zone);
    if (!zone.gridW) zone.gridW = current.w;
    if (!zone.gridH) zone.gridH = current.h;
    if (!zone.scale) zone.scale = assignedFootprint(key, 1).scale || 1;
    zone.customized = true;
  }
  if (assetId) layout.assets[key] = { assetId, solid: false };
  else delete layout.assets[key];
  scheduleSave();
  renderBuildSel();
  renderBuildGrid();
}

async function uploadAssetFile(file) {
  if (!file || !invoke) return;
  const fb = $("#asset-feedback"); if (fb) fb.textContent = "Import…";
  try {
    await Assets.importAsset(invoke, { name: file.name, kind: "prop", file });
    if (fb) fb.textContent = "Importé ✓";
    await Assets.loadAssets(invoke);
    spriteCache.clear();
    renderBuildGrid();
  } catch (err) { if (fb) fb.textContent = "Échec : " + (err?.message || err); }
}
async function onAssetFile(e) {
  const file = e.target.files && e.target.files[0]; e.target.value = "";
  if (file) await uploadAssetFile(file);
}
function assetCategoryOf(a) { return a.category || "Importés"; }

// Peuple le filtre par catégorie (planches d'origine) des assets plaçables.
function populateDockCategories() {
  const sel = $("#dock-category"); if (!sel) return;
  const all = Assets.listAssets().filter((a) => PLACEABLE_KINDS.includes(a.kind));
  const cats = [...new Set(all.map(assetCategoryOf))].sort((a, b) => a.localeCompare(b, "fr"));
  const prev = sel.value;
  sel.innerHTML = "";
  sel.appendChild(new Option(`Toutes les catégories (${all.length})`, "all"));
  for (const c of cats) {
    const n = all.filter((a) => assetCategoryOf(a) === c).length;
    sel.appendChild(new Option(`${c} (${n})`, c));
  }
  sel.value = cats.includes(prev) ? prev : "all";
}

// Grille d'assets (droite du dock). Cliquer un asset l'arme comme sprite ; si un
// bloc agent est sélectionné, l'asset devient son skin.
function renderBuildGrid() {
  const grid = $("#dock-grid"); if (!grid) return;
  populateDockCategories();
  const cat = $("#dock-category")?.value || "all";
  let assets = Assets.listAssets().filter((a) => PLACEABLE_KINDS.includes(a.kind));
  if (cat !== "all") assets = assets.filter((a) => assetCategoryOf(a) === cat);
  grid.innerHTML = "";
  if (!assets.length) { grid.innerHTML = `<p class="asset-empty">Aucun asset dans cette catégorie.</p>`; return; }
  const CAP = 160;
  for (const a of assets.slice(0, CAP)) {
    const card = document.createElement("div");
    card.className = "asset-card" + (brush?.id === a.id ? " active" : "");
    card.title = `${a.name} (${a.kind})`;
    const delBtn = a.builtin ? "" : `<button class="asset-del" title="Supprimer">🗑</button>`;
    card.innerHTML = `<div class="asset-thumb"><img src="${a.data}" alt=""/></div><div class="asset-meta"><span class="asset-n">${escapeHtml(a.name)}</span></div>${delBtn}`;
    const useAsset = () => {
      if (selectedObj?.type) { setZoneSkin(selectedObj.type, a.id); return; }
      brush = a; buildAction = "paint"; selectedObj = null;
      if (brushCfg.type === "zone") setBrushType("object");
      initPendingFootprint(a);
      renderBuildGrid(); updateBuildToolStates(); renderBuildSel();
    };
    card.addEventListener("click", (ev) => { if (ev.target.closest(".asset-del")) return; useAsset(); });
    card.querySelector(".asset-del")?.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!invoke) return;
      try { await Assets.deleteAsset(invoke, a.id); await Assets.loadAssets(invoke); renderBuildGrid(); } catch {}
    });
    grid.appendChild(card);
  }
  if (assets.length > CAP) {
    const note = document.createElement("p"); note.className = "asset-empty";
    note.textContent = `${CAP} sur ${assets.length} affichés — filtre par catégorie pour voir le reste.`;
    grid.appendChild(note);
  }
}

function isolateUiPointerEvents() {
  const stop = (e) => e.stopPropagation();
  document.querySelectorAll(".hud-top, .hud-tools, .build-dock, .special-card, .modal-overlay, .card").forEach((el) => {
    ["mousedown", "mouseup", "mousemove", "dblclick", "touchstart", "touchmove", "touchend"].forEach((type) => {
      el.addEventListener(type, stop);
    });
  });
}

function updateBuildToolStates() {
  document.querySelectorAll(".dock-tool[data-brush]").forEach((el) => el.classList.toggle("active", buildAction === el.dataset.brush));
}

function saveBrushFootprintDefault() {
  if (!isAssetBrush()) return;
  saveAssetSettings(brush.id, {
    w: clamp(parseInt(pendingFootprint.w || 1, 10), 1, 6),
    h: clamp(parseInt(pendingFootprint.h || 1, 10), 1, 6),
    scale: clamp(parseFloat(pendingFootprint.scale || 1), 0.4, 1.4),
    layer: pendingFootprint.layer === "wall" ? "wall" : "object",
    solid: !!pendingFootprint.solid,
  });
}

function setEditMode(on) {
  editMode = on; buildAction = "select"; brush = null; selectedObj = null;
  const dock = $("#build-dock"); if (dock) dock.hidden = !on;
  $("#toggle-build")?.classList.toggle("active", on);
  if (on) {
    renderBuildGrid(); renderBuildSel(); updateBuildToolStates();
  } else {
    const sc = $("#special-card"); if (sc) sc.hidden = true;
  }
}

// Initialise l'empreinte du pinceau à partir du ratio de l'image (défaut sensé).
function initPendingFootprint(a) {
  pendingFootprint = { ...footprintForAsset(a) };
  // On applique le layer/collision du Type courant (pas ceux mémorisés de l'asset).
  setBrushType(brushCfg.type);
  renderBuildSel();
  if (assetFootprintCfg(a.id) || a.w || a.h) return;
  const img = Assets.imageFor(a.id);
  const apply = () => {
    const fb = defaultFootprintForAsset({ ...a, w: img.naturalWidth, h: img.naturalHeight });
    pendingFootprint.w = fb.w; pendingFootprint.h = fb.h;
    renderBuildSel();
  };
  if (Assets.isReady(img)) apply();
  else if (img) img.addEventListener("load", apply, { once: true });
}

// Rend le panneau de configuration (gauche) selon l'objet sélectionné ou la config
// de pose courante. Masque les rangées hors-contexte (zone / sol).
function renderBuildSel() {
  const dock = $("#build-dock"); if (!dock || dock.hidden) return;
  const sel = selectedObj;
  const selSpecial = sel && !sel.type ? sel.special : null;
  const isZone = !!sel?.type;

  // Type effectif affiché.
  let type = brushCfg.type;
  if (isZone) type = "zone";
  else if (sel) type = sel.special ? "special" : (sel.layer === "wall" ? "wall" : "object");
  const typeSel = $("#cfg-type"); if (typeSel && document.activeElement !== typeSel) typeSel.value = type;

  const title = $("#dock-config-title");
  if (title) title.textContent = sel ? (isZone ? "Bloc agent sélectionné" : "Élément sélectionné") : "Nouvel élément";

  // Sous-select bloc agent.
  const zoneRow = $("#cfg-zone-row"), zoneSel = $("#cfg-zone");
  if (zoneRow) zoneRow.hidden = type !== "zone";
  if (zoneSel && type === "zone" && document.activeElement !== zoneSel) zoneSel.value = isZone ? sel.type : brushCfg.zoneType;

  // Objet spécial.
  const specialRow = $("#cfg-special");
  if (specialRow) specialRow.hidden = type !== "special";
  if (type === "special") {
    const fn = selSpecial ? selSpecial.fn : brushCfg.fn;
    const cfg = selSpecial ? (selSpecial.config || "") : brushCfg.fnConfig;
    const fnSel = $("#cfg-fn"); if (fnSel && document.activeElement !== fnSel) fnSel.value = fn;
    const fnCfg = $("#cfg-fn-config"); if (fnCfg && document.activeElement !== fnCfg) fnCfg.value = cfg;
  }

  const showObjCfg = type !== "floor";
  // Layer.
  const layerRow = $("#cfg-layer-row"), layerSel = $("#cfg-layer");
  if (layerRow) layerRow.hidden = !showObjCfg || isZone;
  if (layerSel && showObjCfg && !isZone && document.activeElement !== layerSel) {
    const lv = sel && !isZone ? (sel.layer === "wall" ? "wall" : "object") : (pendingFootprint.layer === "wall" ? "wall" : "object");
    layerSel.value = lv;
  }
  // Collision.
  const solidRow = $("#cfg-solid-row"), solidChk = $("#cfg-solid");
  if (solidRow) solidRow.hidden = !showObjCfg || isZone;
  if (solidChk) solidChk.checked = sel && !isZone ? sel.solid !== false : !!pendingFootprint.solid;
  // Sol par défaut (type sol + asset choisi, hors sélection).
  const fdRow = $("#cfg-floor-default-row"), fdChk = $("#cfg-floor-default");
  const showFd = type === "floor" && !!brush?.id && !sel;
  if (fdRow) fdRow.hidden = !showFd;
  if (fdChk && showFd) fdChk.checked = assetCfg("tile:floor")?.assetId === brush.id;
  // Taille.
  const sizeRow = $("#cfg-size-row");
  if (sizeRow) sizeRow.hidden = !showObjCfg;
  const zoneFp = isZone ? zoneFootprint(sel) : null;
  const zoneAssetFp = isZone ? assignedFootprint(`zone:${sel.type}`, 1) : null;
  const scaleValue = isZone ? (sel.scale || zoneAssetFp.scale || 1) : ((sel ? sel.scale : pendingFootprint.scale) || 1);
  const wValue = isZone ? (sel.gridW || zoneFp.w) : (sel ? (sel.gridW || 1) : pendingFootprint.w);
  const hValue = isZone ? (sel.gridH || zoneFp.h) : (sel ? (sel.gridH || 1) : pendingFootprint.h);
  const scale = $("#cfg-scale"); if (scale && document.activeElement !== scale) scale.value = scaleValue;
  const w = $("#cfg-w"); if (w && document.activeElement !== w) w.value = wValue;
  const h = $("#cfg-h"); if (h && document.activeElement !== h) h.value = hValue;

  // Actions sur la sélection.
  const selRow = $("#cfg-selected"); if (selRow) selRow.hidden = !sel;
  const skinClear = $("#cfg-skin-clear");
  if (skinClear) skinClear.hidden = !(isZone && assetCfg(`zone:${sel.type}`)?.assetId);

  const hint = $("#dock-hint");
  if (hint) {
    hint.textContent = sel
      ? (isZone ? "Clique un asset pour habiller ce bloc, ou déplace-le sur la scène." : "Modifie l'élément, ou clique la scène pour en poser un nouveau.")
      : (type === "zone" || brush?.id) ? "Clique sur la scène pour poser." : "Choisis un asset à droite, puis clique la scène.";
  }
}

// Fiche d'un objet spécial : fonction, historique d'usage, et déclenchement d'une
// tâche vers un agent (qui se dirigera ensuite vers l'objet).
function openSpecialCard(o) {
  const card = $("#special-card"); if (!card || !o.special) return;
  openSpecialObj = o;
  const m = FN_META[o.special.fn] || { icon: "✨", label: o.special.fn, action: "Lancer", placeholder: "Décris la tâche…" };
  const ic = $("#special-icon"); if (ic) ic.textContent = m.icon;
  const title = card.querySelector(".special-title");
  if (title) title.textContent = o.type ? "Bloc agent" : "Objet spécial";
  const fnEl = $("#special-fn"); if (fnEl) fnEl.textContent = m.label;
  const cfg = $("#special-config"); if (cfg) cfg.textContent = o.special.config ? o.special.config : "(aucune configuration)";
  const sel = $("#special-agent");
  if (sel) {
    sel.innerHTML = "";
    if (!agents.length) sel.appendChild(new Option("(aucun agent)", ""));
    for (const a of agents) sel.appendChild(new Option(a.name || a.id, a.id));
  }
  const prompt = $("#special-prompt"); if (prompt) { prompt.value = ""; prompt.placeholder = m.placeholder; }
  const runNow = $("#special-run-now"); if (runNow) runNow.textContent = m.action;
  const fb = $("#special-feedback"); if (fb) fb.textContent = "";
  renderSpecialHistory(o);
  card.hidden = false;
}
function renderSpecialHistory(o) {
  const box = $("#special-history"); if (!box) return;
  const h = (o.special && o.special.history) || [];
  if (!h.length) { box.innerHTML = `<p class="special-empty">Aucune utilisation pour l'instant.</p>`; return; }
  box.innerHTML = h.map((e) =>
    `<div class="hist-row"><span class="hist-name">${escapeHtml(e.name || "?")}</span><span class="hist-task" title="${escapeHtml(e.task || "")}">${escapeHtml(e.task || "")}</span><span class="hist-time">${timeAgo(e.ts)}</span></div>`
  ).join("");
}
// Assigne (et éventuellement lance) une tâche liée à cet objet vers un agent.
async function triggerSpecialTask(run) {
  const o = findSpecialTarget(openSpecialObj);
  const fb = $("#special-feedback");
  if (!o?.special) return;
  if (!invoke) { if (fb) fb.textContent = "Indisponible hors application."; return; }
  const agentId = $("#special-agent")?.value;
  if (!agentId) { if (fb) fb.textContent = "Choisis un agent."; return; }
  const agent = findAgent(agentId); if (!agent) return;
  const text = composeTask(o.special.fn, $("#special-prompt")?.value || "") || (o.special.config || "").trim();
  if (!text) { if (fb) fb.textContent = "Saisis une consigne (ou renseigne la config de l'objet)."; return; }
  if (fb) fb.textContent = "Enregistrement…";
  try {
    const clone = structuredClone(agent); clone.tasks = clone.tasks || [];
    clone.tasks.push({ id: `t-${Date.now()}`, text, done: false, due: null });
    await invoke("agent_save", { agent: clone });
    agent.tasks = clone.tasks;
    if (run) await invoke("agent_run_now", { id: agentId });
    logUsage(o, agentId, text);
    if ($("#special-prompt")) $("#special-prompt").value = "";
    if (fb) fb.textContent = run ? "Tâche lancée ✓ — l'agent se dirige vers l'objet." : "Tâche assignée ✓";
  } catch (e) { if (fb) fb.textContent = "Échec : " + (e?.message || e); }
}

// Rafraîchit le panneau quand la sélection change (boucle légère).
setInterval(() => { if (editMode && !activeBuildField()) renderBuildSel(); }, 250);

// ===== Démarrage =====
window.addEventListener("resize", resize);
initDock();
isolateUiPointerEvents();
resize();
(async () => { await loadLayout(); await loadAgents(); })();
requestAnimationFrame(render);

if (listen) {
  listen("agents-updated", () => loadAgents());
  listen("village-layout-updated", async () => { await loadLayout(); relayout(); });
  listen("village-assets-updated", async () => { await Assets.loadAssets(invoke); spriteCache.clear(); if (editMode) renderBuildGrid(); });
  listen("agent-progress", (e) => {
    for (const p of placed) if (deriveState(p.agent) === "work") refreshActivity(p.agent.id);
    // Interaction : l'agent qui a fini « rend visite » à un autre agent au hasard
    const fromId = e?.payload?.agent_id; if (fromId && placed.length > 1) {
      const others = placed.filter((p) => p.agent.id !== fromId);
      if (others.length) triggerVisit(fromId, others[Math.floor(Math.random() * others.length)].agent.id);
    }
  });
  // Exécution d'un agent : on l'affiche « au travail » en direct (bulle d'activité)
  // tant que l'événement `agent-running` est actif, puis on rafraîchit à la fin.
  listen("agent-running", (e) => {
    const id = e?.payload?.agent_id; if (!id) return;
    if (e?.payload?.active) startRunning(id, e.payload.task);
    else stopRunning(id);
  });
}
// Affichage minimum de l'état « au travail » : une tâche éclair (ex. « annoncer »)
// se termine en quelques dizaines de ms ; sans plancher, la bulle ne serait jamais
// visible. On garde donc l'indication au moins MIN_RUN_MS après le démarrage.
const MIN_RUN_MS = 4000;
const runStart = new Map();      // id -> ts de la première détection « en cours »
const stopTimers = new Map();    // id -> timeout de suppression différée
function startRunning(id, task) {
  // Annule une éventuelle suppression différée (l'agent est de nouveau actif).
  const t = stopTimers.get(id); if (t) { clearTimeout(t); stopTimers.delete(id); }
  if (!runningAgents.has(id)) { runningAgents.add(id); runStart.set(id, Date.now()); recordAutoUsage(id, task); }
  if (task) { taskCache.set(id, task); if (!activityCache.get(id)) activityCache.set(id, task); }
  refreshActivity(id);
  if (selectedId === id) { const a = findAgent(id); if (a) renderCard(a); }
}
function stopRunning(id) {
  if (!runningAgents.has(id) || stopTimers.has(id)) return;
  const elapsed = Date.now() - (runStart.get(id) || 0);
  const delay = Math.max(0, MIN_RUN_MS - elapsed);
  const tid = setTimeout(() => {
    stopTimers.delete(id); runningAgents.delete(id); taskCache.delete(id); runStart.delete(id);
    refreshActivity(id);
    loadAgents();   // l'état des tâches (done) a changé
    if (selectedId === id) { const a = findAgent(id); if (a) renderCard(a); }
  }, delay);
  stopTimers.set(id, tid);
}
// Sondage fiable du backend : indépendant de la livraison des événements à cette
// fenêtre (l'atelier peut être une iframe ou une fenêtre dédiée). Source de vérité
// pour l'état « au travail » affiché sur le personnage.
async function pollRunning() {
  if (!invoke) return;
  let list = [];
  try { list = await invoke("agents_running"); } catch { return; }
  const ids = new Set();
  for (const r of (list || [])) { if (r?.id) { ids.add(r.id); startRunning(r.id, r.task); } }
  for (const id of [...runningAgents]) if (!ids.has(id)) stopRunning(id);
}
setInterval(pollRunning, 1200);
setInterval(() => { for (const p of placed) if (deriveState(p.agent) === "work") refreshActivity(p.agent.id); }, 8000);

// Déconnexion : reverrouille la session et renvoie à l'écran de connexion
// (choix du profil + mot de passe), ce qui permet de changer d'utilisateur.
document.getElementById("hud-logout")?.addEventListener("click", async () => {
  try { await invoke?.("session_lock"); } catch {}
  const top = window.top || window;
  try { top.sessionStorage.removeItem("dtSessionOpen"); } catch {}
  try { top.location.reload(); } catch { location.reload(); }
});

// i18n : traduit le DOM statique + le contenu rendu dynamiquement (mode EN).
autoTranslate({ observe: true });
