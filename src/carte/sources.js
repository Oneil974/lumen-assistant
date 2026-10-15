// Sources de données de l'app Carte. Chaque fonction rend du GeoJSON ET le
// crédit de la donnée : { source, license, licenseUrl, url }. Le crédit suit la
// couche partout (légende, contrôle d'attribution, export GeoJSON) — la
// licence ODbL d'OpenStreetMap et la Licence Ouverte d'Etalab l'exigent.
//
// Toutes ces API acceptent CORS ; à défaut, relais Rust `web_fetch_raw`.

const __TAURI = window.__TAURI__ || (window.parent && window.parent.__TAURI__) || {};
const invoke = __TAURI.core?.invoke;

export const OSM_CREDIT = {
  source: "contributeurs OpenStreetMap", license: "ODbL 1.0",
  licenseUrl: "https://www.openstreetmap.org/copyright", url: "https://www.openstreetmap.org",
};

async function getText(url, init) {
  try {
    const r = await fetch(url, init);
    if (r.ok) return await r.text();
    if (init) throw new Error(`HTTP ${r.status}`);
  } catch (e) { if (init) throw e; }
  if (!invoke) throw new Error("Réseau indisponible.");
  return String(await invoke("web_fetch_raw", { url }));
}
const getJSON = async (url, init) => JSON.parse(await getText(url, init));

/** Texte d'un fichier ouvert : UTF-8 si valide, sinon Latin-1 (fréquent sur data.gouv). */
async function getDecoded(url) {
  try {
    const r = await fetch(url);
    if (r.ok) {
      const buf = await r.arrayBuffer();
      try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return new TextDecoder("windows-1252").decode(buf); }
    }
  } catch {}
  return getText(url);
}

// ---- Fonds de carte ---------------------------------------------------------
const raster = (tiles, attribution, maxzoom = 19) => ({
  version: 8,
  sources: { base: { type: "raster", tiles: [tiles], tileSize: 256, attribution, maxzoom } },
  layers: [{ id: "base", type: "raster", source: "base" }],
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
});
export const BASEMAPS = {
  plan: { label: "Plan (OpenFreeMap)", style: "https://tiles.openfreemap.org/styles/liberty" },
  osm: { label: "OpenStreetMap", style: raster("https://tile.openstreetmap.org/{z}/{x}/{y}.png", '<a href="https://www.openstreetmap.org/copyright" target="_blank">© contributeurs OpenStreetMap</a>') },
  ortho: { label: "Photos aériennes (IGN)", style: raster("https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}", '<a href="https://geoservices.ign.fr" target="_blank">© IGN – Géoplateforme</a> (Licence Ouverte)', 19) },
  topo: { label: "Plan IGN", style: raster("https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/png&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}", '<a href="https://geoservices.ign.fr" target="_blank">© IGN – Géoplateforme</a> (Licence Ouverte)', 19) },
};

// ---- Géocodage --------------------------------------------------------------
/** → [{ label, lon, lat, bbox?:[w,s,e,n], credit }] ; Base Adresse Nationale d'abord pour la France, Nominatim ensuite. */
export async function geocode(q, { franceFirst = true } = {}) {
  const out = [];
  if (franceFirst) {
    try {
      const d = await getJSON(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=5`);
      for (const f of d.features || []) {
        if ((f.properties?.score || 0) < 0.5) continue;
        out.push({ label: f.properties.label, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], type: f.properties.type,
          credit: { source: "Base Adresse Nationale", license: "Licence Ouverte 2.0", licenseUrl: "https://www.etalab.gouv.fr/licence-ouverte-open-licence/", url: "https://adresse.data.gouv.fr" } });
      }
    } catch {}
  }
  try {
    const d = await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`);
    for (const r of d) {
      const [s, n, w, e] = (r.boundingbox || []).map(Number);
      out.push({ label: r.display_name, lon: Number(r.lon), lat: Number(r.lat), type: r.type, bbox: r.boundingbox ? [w, s, e, n] : null, credit: OSM_CREDIT });
    }
  } catch {}
  // Une ville trouvée par la BAN n'a pas d'emprise : Nominatim la donne, on la
  // préfère donc quand les deux répondent pour une commune.
  out.sort((a, b) => (b.bbox && b.type !== "house" ? 1 : 0) - (a.bbox && a.type !== "house" ? 1 : 0));
  return out;
}

// ---- Extraction OpenStreetMap (Overpass) --------------------------------------
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

/** Requête Overpass QL construite à partir de filtres { key, value? } sur une emprise [w,s,e,n]. */
export function buildOverpass(filters, bbox, limit = 2000) {
  const [w, s, e, n] = bbox;
  const bb = `(${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)})`;
  const sel = (f) => (f.value ? `["${f.key}"="${f.value}"]` : `["${f.key}"]`);
  return `[out:json][timeout:40];\n(\n${filters.map((f) => `  nwr${sel(f)}${bb};`).join("\n")}\n);\nout geom ${limit};`;
}

/** Exécute une requête Overpass QL → GeoJSON FeatureCollection. */
export async function overpass(ql) {
  let lastErr = null;
  for (const url of OVERPASS) {
    try {
      // Délai par miroir : un serveur saturé peut ne jamais répondre.
      const data = await getJSON(url, { method: "POST", body: new URLSearchParams({ data: ql }), signal: AbortSignal.timeout(45000) });
      return osmToGeoJSON(data);
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Overpass indisponible (${lastErr?.message || lastErr}). Réessayez dans un instant ou réduisez la zone.`);
}

const AREA_KEYS = /^(building|landuse|natural|leisure|amenity|area|place|boundary|waterway=riverbank|water)$/;
function osmToGeoJSON(data) {
  const features = [];
  for (const el of data.elements || []) {
    const props = { ...(el.tags || {}), "@osm": `${el.type}/${el.id}` };
    let geometry = null;
    if (el.type === "node") geometry = { type: "Point", coordinates: [el.lon, el.lat] };
    else if (el.type === "way" && el.geometry?.length) {
      const c = el.geometry.map((p) => [p.lon, p.lat]);
      const closed = c.length > 3 && c[0][0] === c.at(-1)[0] && c[0][1] === c.at(-1)[1];
      const areaish = closed && Object.keys(el.tags || {}).some((k) => AREA_KEYS.test(k)) && el.tags?.area !== "no";
      geometry = areaish ? { type: "Polygon", coordinates: [c] } : { type: "LineString", coordinates: c };
    } else if (el.type === "relation") {
      const outers = (el.members || []).filter((m) => m.geometry && m.role !== "inner").map((m) => m.geometry.map((p) => [p.lon, p.lat]));
      if (outers.length) geometry = { type: "MultiLineString", coordinates: outers };
      else if (el.bounds) geometry = { type: "Point", coordinates: [(el.bounds.minlon + el.bounds.maxlon) / 2, (el.bounds.minlat + el.bounds.maxlat) / 2] };
    }
    if (geometry) features.push({ type: "Feature", properties: props, geometry });
  }
  return { type: "FeatureCollection", features };
}

// ---- data.gouv.fr -----------------------------------------------------------
const LICENSES = {
  "fr-lo": ["Licence Ouverte 1.0", "https://www.etalab.gouv.fr/licence-ouverte-open-licence/"],
  "lov2": ["Licence Ouverte 2.0", "https://www.etalab.gouv.fr/licence-ouverte-open-licence/"],
  "odc-odbl": ["ODbL", "https://opendatacommons.org/licenses/odbl/"],
  "odc-by": ["ODC-BY", "https://opendatacommons.org/licenses/by/"],
  "odc-pddl": ["ODC-PDDL (domaine public)", "https://opendatacommons.org/licenses/pddl/"],
  "cc-by": ["CC BY", "https://creativecommons.org/licenses/by/4.0/"],
  "cc-by-sa": ["CC BY-SA", "https://creativecommons.org/licenses/by-sa/4.0/"],
  "cc-zero": ["CC0", "https://creativecommons.org/publicdomain/zero/1.0/"],
};
const GEO_FORMATS = /^(geojson|json|csv)$/i;

/** → [{ id, title, org, license, page, resources:[{ title, format, url, size }] }] */
export async function datagouvSearch(q) {
  const d = await getJSON(`https://www.data.gouv.fr/api/1/datasets/?q=${encodeURIComponent(q)}&page_size=12`);
  return (d.data || []).map((x) => ({
    id: x.id, title: x.title, org: x.organization?.name || x.owner?.first_name || "", page: x.page,
    license: x.license,
    resources: (x.resources || []).filter((r) => GEO_FORMATS.test(r.format || "") || /geojson/i.test(r.url || "")).map((r) => ({
      title: r.title || r.format, format: String(r.format || "").toLowerCase(), url: r.url, size: r.filesize,
    })),
  })).filter((x) => x.resources.length);
}

export function datagouvCredit(ds) {
  const [license, licenseUrl] = LICENSES[ds.license] || [ds.license || "voir la fiche", ds.page];
  return { source: `${ds.org || "data.gouv.fr"} via data.gouv.fr`, license, licenseUrl, url: ds.page };
}

/** Charge une ressource → GeoJSON (GeoJSON natif, ou CSV/JSON avec colonnes lat/lon). */
export async function loadResource(res) {
  const text = (await getDecoded(res.url)).replace(/^\uFEFF/, "");
  if (text.length > 60e6) throw new Error("Fichier trop volumineux pour la carte (> 60 Mo).");
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    const j = JSON.parse(t);
    if (j.type === "FeatureCollection" || j.type === "Feature") return j.type === "Feature" ? { type: "FeatureCollection", features: [j] } : j;
    const rows = Array.isArray(j) ? j : j.results || j.data || j.records || [];
    return rowsToGeoJSON(rows.map((r) => r.fields || r));
  }
  return rowsToGeoJSON(parseCSV(t));
}

function parseCSV(text) {
  const head = text.slice(0, text.indexOf("\n"));
  const sep = [";", ",", "\t"].sort((a, b) => head.split(b).length - head.split(a).length)[0];
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur.replace(/\r$/, "")); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [cols, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(cols.map((c, i) => [c.trim(), r[i]])));
}

const LAT = /^(lat|latitude|y|y_wgs84|lat_wgs84|coord_lat)$/i;
const LON = /^(lon|lng|long|longitude|x|x_wgs84|lon_wgs84|coord_lon)$/i;
const PAIR = /(geo_?point|coord|gps|geoloc|position|wgs84)/i;
const norm = (k) => k.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const PAIR_VALUE = /^\s*\[?\s*(-?\d{1,2}\.\d+)\s*[,; ]\s*(-?\d{1,3}\.\d+)\s*\]?\s*$/;
function rowsToGeoJSON(rows) {
  if (!rows.length) throw new Error("Aucune ligne dans la ressource.");
  const keys = Object.keys(rows[0]);
  const la = keys.find((k) => LAT.test(norm(k))), lo = keys.find((k) => LON.test(norm(k)));
  // Colonne « lat, lon » : par son nom, sinon la première dont la valeur a cette forme.
  const pair = keys.find((k) => PAIR.test(norm(k)) && (typeof rows[0][k] === "object" || PAIR_VALUE.test(String(rows[0][k] || ""))))
    || keys.find((k) => PAIR_VALUE.test(String(rows[0][k] || "")));
  const geomKey = keys.find((k) => /^(geo_shape|geometry|geom)$/i.test(k));
  const features = [];
  for (const r of rows) {
    let lat, lon, geometry = null;
    const g = r[geomKey];
    if (g && typeof g === "object" && g.type) geometry = g.geometry || g;
    else if (la && lo) { lat = parseFloat(String(r[la]).replace(",", ".")); lon = parseFloat(String(r[lo]).replace(",", ".")); }
    else if (pair) {
      const v = r[pair];
      if (v && typeof v === "object") { lat = v.lat; lon = v.lon; }
      else { const m = String(v || "").match(PAIR_VALUE); if (m) [lat, lon] = [Number(m[1]), Number(m[2])]; }
    }
    if (!geometry && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) geometry = { type: "Point", coordinates: [lon, lat] };
    if (!geometry) continue;
    const props = { ...r };
    delete props[geomKey];
    features.push({ type: "Feature", properties: props, geometry });
  }
  if (!features.length) throw new Error("Pas de coordonnées reconnues (colonnes latitude/longitude ou géométrie).");
  return { type: "FeatureCollection", features };
}

/** Emprise [w,s,e,n] d'un GeoJSON. */
export function bboxOf(fc) {
  let w = 180, s = 90, e = -180, n = -90;
  const visit = (c) => { if (typeof c[0] === "number") { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(visit); };
  for (const f of fc.features || []) if (f.geometry?.coordinates) visit(f.geometry.coordinates);
  return w <= e ? [w, s, e, n] : null;
}
