// Carte — cartographie assistée par IA.
//
// Couches (magasin d'app « carte ») :
//   layers [{ id, name, color, visible, credit:{source,license,licenseUrl,url}, data:FeatureCollection }]
//   view   { center:[lon,lat], zoom, basemap }
// Chaque couche garde le crédit de sa donnée : il est réaffiché dans la liste,
// injecté dans le contrôle d'attribution de MapLibre et écrit dans le GeoJSON
// exporté (membres « attribution » / « license »), comme l'exigent l'ODbL
// d'OpenStreetMap et la Licence Ouverte.

import { autoTranslate, registerTranslations, tt } from "../apps-i18n.js";
import { createStore } from "../lib/app-state.js";
import { icon } from "../lib/icons.js";
import { CARTE_EN } from "./i18n.js";
import { BASEMAPS, OSM_CREDIT, geocode, buildOverpass, overpass, datagouvSearch, datagouvCredit, loadResource, bboxOf } from "./sources.js";
import { catalog, toolDeck, runTool } from "./tools.js";
import { runAiTools } from "../lib/ai-prompt.js?v=5";
import { mountSig } from "./sig.js";

registerTranslations(CARTE_EN);

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const { invoke } = __TAURI.core || {};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const store = createStore("carte");
const COLORS = ["#ff375f", "#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#16b8a6", "#5e5ce6", "#d8a31f"];
const LANG = () => (tt("Couches") === "Layers" ? "en" : "fr");
const MAX_PERSIST = 8e6; // au-delà, la couche reste en mémoire (non enregistrée)

const PRESETS = [
  ["amenity", "pharmacy", "Pharmacies"], ["amenity", "hospital", "Hôpitaux"], ["amenity", "school", "Écoles"],
  ["amenity", "restaurant", "Restaurants"], ["amenity", "cafe", "Cafés"], ["amenity", "drinking_water", "Points d'eau potable"],
  ["amenity", "toilets", "Toilettes"], ["amenity", "charging_station", "Bornes de recharge"], ["amenity", "bicycle_parking", "Parkings vélo"],
  ["emergency", "defibrillator", "Défibrillateurs"], ["shop", "bakery", "Boulangeries"], ["shop", "supermarket", "Supermarchés"],
  ["tourism", "museum", "Musées"], ["tourism", "viewpoint", "Points de vue"], ["leisure", "park", "Parcs"],
  ["leisure", "playground", "Aires de jeux"], ["highway", "cycleway", "Pistes cyclables"], ["railway", "station", "Gares"],
  ["public_transport", "stop_position", "Arrêts de transport"], ["natural", "peak", "Sommets"], ["historic", "", "Patrimoine historique"],
];

let map = null;
let interactionMode = null;
let sig = null;
let layers = [];
let history = [];
let basemap = "plan";

function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3600); }
function busy(msg) { const b = $("busy"); b.hidden = !msg; if (msg) b.querySelector("span").textContent = msg; }
function paintIcons(root = document) { root.querySelectorAll("[data-ic]").forEach((n) => { if (!n.firstChild) n.innerHTML = icon(n.dataset.ic) || ""; }); }
const bboxNow = () => { const b = map.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; };
const creditText = (c) => (c ? `© ${c.source} — ${c.license}` : "");

// ===== Carte =================================================================
function initMap() {
  const v = store.getJSON("view", null) || { center: [2.35, 46.6], zoom: 5, basemap: "plan" };
  basemap = BASEMAPS[v.basemap] ? v.basemap : "plan";
  map = new maplibregl.Map({
    container: "map", style: BASEMAPS[basemap].style, center: v.center, zoom: v.zoom,
    attributionControl: false, hash: false,
    // Captures (PNG, carte PDF) : le tampon doit survivre au rendu.
    preserveDrawingBuffer: true,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");
  // Redimensionnement de la fenêtre ou retour au premier plan : recaler le canevas.
  new ResizeObserver(() => map.resize()).observe($("map"));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { map.resize(); map.triggerRepaint(); } });
  attribution = new maplibregl.AttributionControl({ compact: false, customAttribution: [] });
  map.addControl(attribution, "bottom-right");
  // Un changement de fond efface les couches : on les repose à chaque style.
  map.on("style.load", () => { for (const l of layers) mountLayer(l); refreshAttribution(); });
  map.on("moveend", () => store.set("view", { center: map.getCenter().toArray(), zoom: map.getZoom(), basemap }));
  map.on("click", (e) => {
    if (interactionMode) return; // mesure ou choix d'un point en cours (onglet SIG)
    const ids = layers.filter((l) => l.visible).flatMap((l) => [`${l.id}-fill`, `${l.id}-line`, `${l.id}-pt`]).filter((id) => map.getLayer(id));
    const f = ids.length ? map.queryRenderedFeatures(e.point, { layers: ids })[0] : null;
    if (!f) return;
    const l = layers.find((x) => f.layer.id.startsWith(x.id));
    const rows = Object.entries(f.properties || {}).filter(([k, v]) => v !== "" && v != null && !k.startsWith("@")).slice(0, 18);
    const title = f.properties.name || f.properties.nom || f.properties.label || l?.name || "";
    new maplibregl.Popup({ maxWidth: "320px" }).setLngLat(e.lngLat).setHTML(`<div class="pop"><b>${esc(title)}</b><table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${linkify(v)}</td></tr>`).join("")}</table>${f.properties["@osm"] ? `<a href="https://www.openstreetmap.org/${esc(f.properties["@osm"])}" target="_blank" rel="noopener">${esc(tt("Voir sur OpenStreetMap"))}</a>` : ""}<small>${esc(creditText(l?.credit))}</small></div>`).addTo(map);
  });
  map.on("mousemove", (e) => {
    if (interactionMode) return;
    const ids = layers.filter((l) => l.visible).flatMap((l) => [`${l.id}-pt`, `${l.id}-fill`, `${l.id}-line`]).filter((id) => map.getLayer(id));
    map.getCanvas().style.cursor = ids.length && map.queryRenderedFeatures(e.point, { layers: ids }).length ? "pointer" : "";
  });
}
let attribution = null;
const linkify = (v) => { const s = typeof v === "object" ? JSON.stringify(v) : String(v); return /^https?:\/\//.test(s) ? `<a href="${esc(s)}" target="_blank" rel="noopener">${esc(s.slice(0, 40))}</a>` : esc(s.slice(0, 200)); };

/** Crédits des couches dans le contrôle d'attribution (en plus de ceux du fond). */
function refreshAttribution() {
  if (!attribution) return;
  const seen = new Set();
  const parts = [];
  for (const l of layers) {
    if (!l.visible || !l.credit) continue;
    const key = `${l.credit.source}|${l.credit.license}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`<a href="${esc(l.credit.licenseUrl || l.credit.url || "#")}" target="_blank" rel="noopener">© ${esc(l.credit.source)} (${esc(l.credit.license)})</a>`);
  }
  attribution.options.customAttribution = parts;
  try { attribution._updateAttributions(); } catch {}
}

function mountLayer(l) {
  if (!map.isStyleLoaded()) { map.once("idle", () => mountLayer(l)); return; }
  for (const s of SUBLAYERS) if (map.getLayer(l.id + s)) map.removeLayer(l.id + s);
  if (map.getSource(l.id)) map.removeSource(l.id);
  map.addSource(l.id, { type: "geojson", data: l.data });
  const vis = l.visible ? "visible" : "none";
  map.addLayer({ id: `${l.id}-fill`, type: "fill", source: l.id, filter: ["==", ["geometry-type"], "Polygon"], layout: { visibility: vis }, paint: { "fill-color": l.color, "fill-opacity": 0.25 } });
  map.addLayer({ id: `${l.id}-line`, type: "line", source: l.id, filter: ["!=", ["geometry-type"], "Point"], layout: { visibility: vis }, paint: { "line-color": l.color, "line-width": 2.2 } });
  if (l.heat) map.addLayer({ id: `${l.id}-heat`, type: "heatmap", source: l.id, filter: ["==", ["geometry-type"], "Point"], layout: { visibility: vis }, paint: { "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 5, 8, 15, 28], "heatmap-opacity": 0.8 } });
  map.addLayer({ id: `${l.id}-pt`, type: "circle", source: l.id, filter: ["==", ["geometry-type"], "Point"], minzoom: l.heat ? 14 : 0, layout: { visibility: vis }, paint: { "circle-color": l.color, "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 14, 6], "circle-stroke-color": "#fff", "circle-stroke-width": 1.2 } });
}

const SUBLAYERS = ["-fill", "-line", "-pt", "-heat", "-lbl"];

function addLayer({ name, data, credit, origin = "carte" }) {
  const l = { id: uid(), name, color: COLORS[layers.length % COLORS.length], visible: true, credit, data, origin };
  layers.push(l);
  mountLayer(l);
  afterChange(l);
  return l;
}
/** Après toute modification : persistance, UI, attribution. */
function afterChange() {
  persist(); renderLayers(); refreshAttribution(); sig?.refresh();
}
function updateLayer(l, patch) {
  const visOnly = Object.keys(patch).length === 1 && "visible" in patch;
  Object.assign(l, patch);
  if (visOnly) {
    for (const s of SUBLAYERS) if (map.getLayer(l.id + s)) map.setLayoutProperty(l.id + s, "visibility", l.visible ? "visible" : "none");
    persist(); refreshAttribution();
    return;
  }
  if (map.getSource(l.id)) map.getSource(l.id).setData(l.data);
  mountLayer(l);
  afterChange(l);
}
function removeLayer(l) {
  layers = layers.filter((x) => x !== l);
  for (const s of SUBLAYERS) if (map.getLayer(l.id + s)) map.removeLayer(l.id + s);
  if (map.getSource(l.id)) map.removeSource(l.id);
  afterChange(null);
}
const findLayer = (ref) => {
  const r = String(ref || "").trim().toLowerCase();
  return layers.find((l) => l.id.toLowerCase() === r) || layers.find((l) => l.name.toLowerCase() === r) || layers.find((l) => l.name.toLowerCase().includes(r));
};
/** Ajoute des objets à une couche existante (par id/nom), sinon en crée une. */
function appendOrCreate(ref, features, credit) {
  const l = findLayer(ref);
  if (l && l.origin !== "import") { l.data = { type: "FeatureCollection", features: [...l.data.features, ...features] }; updateLayer(l, {}); return l; }
  return addLayer({ name: ref, data: { type: "FeatureCollection", features }, credit });
}
function persist() {
  const keep = [];
  let size = 0;
  for (const l of layers) { const n = JSON.stringify(l.data).length; if (size + n < MAX_PERSIST) { keep.push(l); size += n; } }
  store.set("layers", keep);
}

function renderLayers() {
  $("layer-count").textContent = layers.length || "";
  $("layers").innerHTML = layers.map((l) => `
    <div class="layer" data-id="${l.id}">
      <div class="lrow"><input type="checkbox" data-vis ${l.visible ? "checked" : ""}/><input type="color" data-color value="${l.color}"/>
        <b class="grow" title="${esc(l.name)}">${esc(l.name)}</b><small class="muted">${l.data.features.length}</small>
        <button class="btn-ico" data-zoom title="${esc(tt("Zoomer sur la couche"))}">⌖</button>
        <button class="btn-ico" data-save title="${esc(tt("Exporter en GeoJSON"))}">⤓</button>
        <button class="btn-ico" data-del title="${esc(tt("Retirer"))}">✕</button></div>
      ${l.credit ? `<small class="credit">© <a href="${esc(l.credit.url || l.credit.licenseUrl || "#")}" target="_blank" rel="noopener">${esc(l.credit.source)}</a> · <a href="${esc(l.credit.licenseUrl || "#")}" target="_blank" rel="noopener">${esc(l.credit.license)}</a></small>` : ""}
    </div>`).join("") || `<p class="muted">${esc(tt("Aucune couche. Demandez-en une à l'assistant, ou extrayez des données dans l'onglet « Données »."))}</p>`;
}

function onLayersClick(e) {
  const box = e.target.closest(".layer");
  if (!box) return;
  const l = layers.find((x) => x.id === box.dataset.id);
  if (!l) return;
  if (e.target.closest("[data-del]")) removeLayer(l);
  else if (e.target.closest("[data-zoom]")) fitTo(bboxOf(l.data));
  else if (e.target.closest("[data-save]")) exportLayers([l]);
}
function onLayersChange(e) {
  const box = e.target.closest(".layer");
  const l = box && layers.find((x) => x.id === box.dataset.id);
  if (!l) return;
  if (e.target.matches("[data-vis]")) updateLayer(l, { visible: e.target.checked });
  if (e.target.matches("[data-color]")) updateLayer(l, { color: e.target.value });
}

function fitTo(bb, maxZoom = 16) {
  if (!bb) return;
  // Fenêtre cachée (assistant piloté depuis ailleurs) : pas d'animation, rAF y est gelé.
  const duration = document.hidden ? 0 : 900;
  if (bb[0] === bb[2] && bb[1] === bb[3]) map.easeTo({ center: [bb[0], bb[1]], zoom: 15, duration });
  else map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 50, maxZoom, duration });
}

function setBasemap(id) {
  if (!BASEMAPS[id] || id === basemap) return;
  basemap = id;
  $("basemap").value = id;
  map.setStyle(BASEMAPS[id].style);
  store.set("view", { center: map.getCenter().toArray(), zoom: map.getZoom(), basemap });
}

// ===== Lieux =====================================================================
async function goTo(q) {
  const hits = await geocode(q);
  if (!hits.length) throw new Error(tt("Lieu introuvable : {q}", { q }));
  const h = hits[0];
  if (h.bbox) fitTo(h.bbox, 15); else map.easeTo({ center: [h.lon, h.lat], zoom: h.type === "municipality" ? 12 : 16, duration: document.hidden ? 0 : 900 });
  // Pas de moveend si la carte est déjà sur place : filet de 2,5 s.
  await new Promise((r) => setTimeout(r, 50));
  await settled();
  return h;
}

let suggestTimer = null;
function wireSearch() {
  const input = $("search-input"), box = $("suggest");
  input.oninput = () => {
    clearTimeout(suggestTimer);
    const q = input.value.trim();
    if (q.length < 3) { box.hidden = true; return; }
    suggestTimer = setTimeout(async () => {
      const hits = await geocode(q).catch(() => []);
      box.innerHTML = hits.slice(0, 7).map((h, i) => `<button data-i="${i}"><span class="grow">${esc(h.label)}</span><small>${esc(h.credit.source)}</small></button>`).join("");
      box.hidden = !hits.length;
      box.onclick = (e) => {
        const b = e.target.closest("[data-i]"); if (!b) return;
        const h = hits[Number(b.dataset.i)];
        box.hidden = true; input.value = h.label;
        if (h.bbox) fitTo(h.bbox, 15); else map.flyTo({ center: [h.lon, h.lat], zoom: 16 });
      };
    }, 350);
  };
  $("search").onsubmit = async (e) => { e.preventDefault(); box.hidden = true; try { await goTo(input.value.trim()); } catch (err) { toast(err.message); } };
  document.addEventListener("click", (e) => { if (!e.target.closest("#search, #suggest")) box.hidden = true; });
}

// ===== Extraction OSM ==============================================================
/** Attend la fin d'un déplacement en cours (animation fitBounds/flyTo). */
async function settled(max = 3000) {
  const t0 = Date.now();
  while (map.isMoving() && !document.hidden && Date.now() - t0 < max) await new Promise((r) => setTimeout(r, 100));
}
async function extractOSM(filters, label) {
  await settled();
  if (map.getZoom() < 9) throw new Error(tt("Zone trop grande : zoomez sur une ville ou une région pour extraire des données OSM."));
  busy(tt("Extraction OpenStreetMap…"));
  try {
    const data = await overpass(buildOverpass(filters, bboxNow()));
    if (!data.features.length) { toast(tt("Aucun objet « {l} » dans cette zone.", { l: label })); return null; }
    return addLayer({ name: `${label} (OSM)`, data, credit: OSM_CREDIT });
  } finally { busy(null); }
}

// ===== data.gouv.fr ================================================================
async function searchDatagouv(q, { quiet = false } = {}) {
  $("dg-list").innerHTML = `<p class="muted">${esc(tt("Recherche…"))}</p>`;
  if (!quiet) switchTab("data");
  $("dg-q").value = q;
  try {
    const list = await datagouvSearch(q);
    $("dg-list").innerHTML = list.map((d, i) => `
      <div class="ds"><b>${esc(d.title)}</b><small class="muted">${esc(d.org)} · ${esc(datagouvCredit(d).license)} · <a href="${esc(d.page)}" target="_blank" rel="noopener">${esc(tt("fiche"))}</a></small>
        <div class="res">${d.resources.slice(0, 6).map((r, j) => `<button class="chip" data-ds="${i}" data-res="${j}">${esc(r.format.toUpperCase())} · ${esc(String(r.title).slice(0, 40))}</button>`).join("")}</div></div>`).join("")
      || `<p class="muted">${esc(tt("Aucun jeu de données géographique trouvé."))}</p>`;
    $("dg-list").onclick = async (e) => {
      const b = e.target.closest("[data-res]"); if (!b) return;
      const d = list[Number(b.dataset.ds)], r = d.resources[Number(b.dataset.res)];
      busy(tt("Chargement de « {t} »…", { t: d.title }));
      try {
        const data = await loadResource(r);
        const l = addLayer({ name: d.title, data, credit: datagouvCredit(d) });
        fitTo(bboxOf(l.data), 14);
        toast(tt("{n} objets chargés.", { n: data.features.length }));
      } catch (err) { toast(`${tt("Ressource illisible")} : ${err.message}`); }
      finally { busy(null); }
    };
    return list;
  } catch (e) { $("dg-list").innerHTML = `<p class="muted">${esc(e.message)}</p>`; return []; }
}

// ===== Assistant =====================================================================
function say(role, html) {
  const d = document.createElement("div");
  d.className = `msg ${role}`;
  d.innerHTML = html;
  $("chat").appendChild(d);
  $("chat").scrollTop = $("chat").scrollHeight;
  return d;
}
function layersSummary() {
  return layers.map((l) => {
    const names = l.data.features.map((f) => f.properties?.name || f.properties?.nom).filter(Boolean).slice(0, 8);
    return `- ${l.name} : ${l.data.features.length} objets${names.length ? ` (ex. ${names.join(", ")})` : ""} — ${creditText(l.credit)}`;
  }).join("\n");
}
const TOOLS = catalog();
function stateText() {
  const c = map.getCenter();
  return `Vue : centre ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}, zoom ${map.getZoom().toFixed(1)}, fond ${basemap}.
Couches (${layers.length}) :
${layersSummary() || "(aucune)"}`;
}
/** API de l'app donnée aux outils. */
const ctx = {
  get map() { return map; }, get layers() { return layers; }, dgCache: null, stateText, goTo, fitTo, setBasemap, extractOSM, addLayer, updateLayer, removeLayer, findLayer, appendOrCreate,
  bbox: () => bboxNow(), exportLayers, snapshot,
  searchDatagouv: (q) => searchDatagouv(q, { quiet: true }),
  onTool: null,
  get basemap() { return basemap; }, invoke,
  toast, busy, lang: LANG,
  setInteractionMode: (m) => { interactionMode = m; },
  saveBinary,
};

/** Fichier binaire dans la 1re sandbox (Cartes/…), sinon téléchargement. */
async function saveBinary(path, bytes, mime) {
  const name = path.split("/").pop();
  try {
    const sb = ((await invoke?.("sandbox_list")) || [])[0];
    if (!sb) throw new Error("no sandbox");
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    await invoke("sandbox_import_file", { id: sb.id, path, dataB64: btoa(bin) });
    const msg = tt("Enregistré : {sb} › {p}", { sb: sb.name, p: path });
    toast(msg);
    return msg;
  } catch {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return tt("Téléchargé : {n}", { n: name });
  }
}

async function ask(text) {
  say("me", esc(text));
  const pending = say("bot", `<span class="muted">${esc(tt("Réflexion…"))}</span><ul class="steps"></ul>`);
  const steps = pending.querySelector(".steps");
  ctx.onTool = (name) => { busy(`${tt("Outil")} : ${name}`); };
  try {
    const answer = await runAiTools({
      app: "Carte",
      intro: "Tu pilotes une carte interactive (MapLibre). Les données ont TOUJOURS une source et une licence : mentionne-les quand tu ajoutes des données.",
      rules: `- Outils courants directement disponibles ; pour le reste (itinéraires, analyses, filtres, styles, export…), appelle lister_outils(categorie) puis executer_outil(nom, arguments).
- Désigne les couches par leur id (ex. ${layers[0]?.id || "l…"}) donné par etat_carte ou par les résultats d'outils.
- N'extrais pas d'OSM sur une zone plus grande qu'une ville ou un département : déplace-toi d'abord (aller_a).
- Pour ajouter des données fournies par l'utilisateur ou connues de toi (lieux, adresses), utilise ajouter_points.
- Géotraitements façon Turf (tampon, enveloppe, centroïdes, jointure spatiale, grille, regroupements, découpe, intersections, interpolation…) : catégorie « sig ».
- Carte imprimable / plan d'accès / carte de localisation en PDF : carte_pdf. Les repères, l'échelle et l'accès y sont calculés ; ne les invente pas.
- Réponds en ${LANG() === "en" ? "anglais" : "français"}, brièvement.`,
      tools: toolDeck(TOOLS),
      execute: (name, args) => runTool(TOOLS, name, args, ctx),
      context: stateText,
      maxTurns: 12,
    }, text, (st) => {
      if (st.kind !== "tool") return;
      const shown = st.name === "executer_outil" ? st.args?.nom : st.name;
      if (st.name === "lister_outils") return;
      const li = document.createElement("li");
      li.textContent = `${shown} → ${String(st.result).split("\n")[0].slice(0, 140)}`;
      steps.appendChild(li);
      $("chat").scrollTop = $("chat").scrollHeight;
    }, history.slice(-8));
    history.push({ role: "user", content: text }, { role: "assistant", content: answer });
    pending.firstChild.replaceWith(Object.assign(document.createElement("div"), { innerHTML: esc(answer).replace(/\n/g, "<br>") }));
  } catch (e) { pending.firstChild.replaceWith(Object.assign(document.createElement("span"), { className: "muted", textContent: e.message || String(e) })); }
  finally { busy(null); }
}

// ===== Export / import ================================================================
async function exportLayers(list = layers.filter((l) => l.visible)) {
  if (!list.length) { toast(tt("Aucune couche à exporter.")); return tt("Aucune couche à exporter."); }
  const credits = [...new Set(list.filter((l) => l.credit).map((l) => `${l.credit.source} — ${l.credit.license} (${l.credit.licenseUrl || l.credit.url})`))];
  const fc = {
    type: "FeatureCollection",
    // Membres étrangers (RFC 7946 §6.1) : la licence voyage avec la donnée.
    attribution: credits.join(" ; "),
    features: list.flatMap((l) => l.data.features.map((f) => ({ ...f, properties: { ...f.properties, "@layer": l.name, "@source": l.credit?.source || "", "@license": l.credit?.license || "" } }))),
  };
  const name = `${(list.length === 1 ? list[0].name : "carte").replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 50) || "carte"}.geojson`;
  const content = JSON.stringify(fc);
  try {
    const sbs = (await invoke?.("sandbox_list")) || [];
    if (!sbs.length) throw new Error("no sandbox");
    const sb = sbs[0];
    await invoke("sandbox_write_file", { id: sb.id, path: `Cartes/${name}`, content });
    await invoke("sandbox_write_file", { id: sb.id, path: `Cartes/${name.replace(/\.geojson$/, "")}-SOURCES.txt`, content: `${tt("Sources et licences des données")} :\n${credits.map((c) => `- ${c}`).join("\n")}\n` });
    const msg = tt("Exporté dans {sb} › Cartes/{n} (avec ses crédits).", { sb: sb.name, n: name });
    toast(msg);
    return msg;
  } catch {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: "application/geo+json" }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return `Téléchargé : ${name}`;
  }
}

/** Capture PNG de la carte (fond + couches) dans Cartes/. */
async function snapshot(nom) {
  await new Promise((r) => { map.once("render", r); map.triggerRepaint(); });
  const url = map.getCanvas().toDataURL("image/png");
  const name = `${String(nom || "carte").replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "carte"}.png`;
  const credits = [...new Set([...document.querySelectorAll(".maplibregl-ctrl-attrib-inner")].map((n) => n.textContent.trim()))].join(" | ");
  try {
    const sb = ((await invoke?.("sandbox_list")) || [])[0];
    if (!sb) throw new Error();
    await invoke("sandbox_import_file", { id: sb.id, path: `Cartes/${name}`, dataB64: url.split(",")[1] });
    await invoke("sandbox_write_file", { id: sb.id, path: `Cartes/${name.replace(/\.png$/, "")}-SOURCES.txt`, content: `${credits}\n` });
    return `Image enregistrée : ${sb.name} › Cartes/${name}`;
  } catch {
    const a = document.createElement("a"); a.href = url; a.download = name; a.click();
    return `Image téléchargée : ${name}`;
  }
}
async function importFile(file) {
  try {
    const j = JSON.parse(await file.text());
    const data = j.type === "Feature" ? { type: "FeatureCollection", features: [j] } : j;
    if (data.type !== "FeatureCollection") throw new Error(tt("Ce n'est pas un GeoJSON."));
    const credit = j.attribution ? { source: String(j.attribution).slice(0, 200), license: tt("voir le fichier"), url: "" } : null;
    const l = addLayer({ name: file.name.replace(/\.(geo)?json$/i, ""), data, credit });
    fitTo(bboxOf(l.data));
  } catch (e) { toast(e.message); }
}

// ===== Onglets, démarrage ===================================================
function switchTab(tab) {
  document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === tab));
  document.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== tab));
}

async function init() {
  paintIcons();
  await store.ready();
  layers = (store.getJSON("layers", []) || []).filter((l) => l?.data?.features);
  $("basemap").innerHTML = Object.entries(BASEMAPS).map(([k, b]) => `<option value="${k}">${esc(tt(b.label))}</option>`).join("");
  $("osm-preset").innerHTML = PRESETS.map(([k, v, label], i) => `<option value="${i}">${esc(tt(label))}</option>`).join("");
  initMap();
  $("basemap").value = basemap;
  $("basemap").onchange = (e) => setBasemap(e.target.value);
  renderLayers();
  wireSearch();
  sig = mountSig(ctx);
  document.querySelector(".tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) switchTab(b.dataset.tab); };
  $("layers").onclick = onLayersClick;
  $("layers").onchange = onLayersChange;
  $("import").onchange = (e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; };
  $("osm-go").onclick = async () => {
    const [k, v, label] = PRESETS[Number($("osm-preset").value)];
    try { const l = await extractOSM([{ key: k, value: v }], tt(label)); if (l) toast(tt("{n} objets extraits.", { n: l.data.features.length })); } catch (e) { toast(e.message); }
  };
  $("osm-ql-go").onclick = async () => {
    const [w, s, e, n] = bboxNow();
    const ql = $("osm-ql").value.replace(/\{\{bbox\}\}/g, `${s},${w},${n},${e}`);
    if (!ql.trim()) return;
    busy(tt("Extraction OpenStreetMap…"));
    try { const data = await overpass(ql); addLayer({ name: tt("Requête Overpass"), data, credit: OSM_CREDIT }); toast(tt("{n} objets extraits.", { n: data.features.length })); }
    catch (err) { toast(err.message); } finally { busy(null); }
  };
  $("dg-go").onclick = () => $("dg-q").value.trim() && searchDatagouv($("dg-q").value.trim());
  $("dg-q").onkeydown = (e) => { if (e.key === "Enter") $("dg-go").click(); };
  $("export").onclick = () => exportLayers();
  $("ask").onsubmit = (e) => { e.preventDefault(); const t = $("ask-input").value.trim(); if (!t) return; $("ask-input").value = ""; ask(t); };
  $("ask-input").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("ask").requestSubmit(); } };
  const src = (localStorage.getItem("aiSource") || "").toLowerCase();
  $("privacy").textContent = ["api", "lumen"].includes(src) ? tt("IA en ligne") : tt("IA locale");
  registerIntents();
  autoTranslate({ observe: true });
}

// ===== App Intents =====================================================================
function registerIntents() {
  const api = window.lumen?.intents;
  if (!api) return;
  api.on("carte_show", async ({ request }) => { await ask(String(request || "")); return `Fait. ${stateText()}`; }).catch(() => {});
  api.on("carte_layers", async () => layersSummary() || "Aucune couche affichée.").catch(() => {});
}

init();
