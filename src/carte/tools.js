// Outils cartographiques de l'assistant de Carte.
//
// Deux niveaux, pour ne pas saturer le contexte d'un petit modèle local :
//   • niveau 1 — une dizaine d'outils courants, présentés à chaque tour ;
//   • niveau 2 — le reste du catalogue, découvert à la demande :
//     `lister_outils(categorie)` rend noms + paramètres d'UNE catégorie, puis
//     `executer_outil(nom, arguments)` l'appelle.
// Les résultats renvoyés au modèle sont TOUJOURS des résumés courts (jamais le
// GeoJSON) : comptes, noms d'exemple, identifiants de couches.
//
// `ctx` est l'API de l'app (main.js) : map, layers, addLayer, removeLayer…

import { tool, T } from "../lib/ai-prompt.js?v=5";
import { OPS, runOp, resolvePlace, makePdf } from "./sig.js";
import { route, isoline, matrix, routeSummary, IGN_CREDIT } from "./route.js";
import { fmtMin, cardinal, bearing as capOf, bbox as bboxGeo, fc as fcOf, point as pointOf } from "./geo.js";
import { geocode, buildOverpass, overpass, OSM_CREDIT, datagouvSearch, datagouvCredit, loadResource, bboxOf } from "./sources.js";

const BAN = { source: "Base Adresse Nationale", license: "Licence Ouverte 2.0", licenseUrl: "https://www.etalab.gouv.fr/licence-ouverte-open-licence/", url: "https://adresse.data.gouv.fr" };
const IGN = { source: "IGN – Géoplateforme", license: "Licence Ouverte 2.0", licenseUrl: "https://www.etalab.gouv.fr/licence-ouverte-open-licence/", url: "https://geoservices.ign.fr/services-geoplateforme-itineraire" };
const GEOAPI = { source: "API Découpage administratif (geo.api.gouv.fr)", license: "Licence Ouverte 2.0", licenseUrl: "https://www.etalab.gouv.fr/licence-ouverte-open-licence/", url: "https://geo.api.gouv.fr" };

// ---- Géométrie minimale (WGS84) -----------------------------------------------
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export function haversine([lon1, lat1], [lon2, lat2]) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function centroid(g) {
  if (!g) return null;
  if (g.type === "Point") return g.coordinates;
  let sx = 0, sy = 0, n = 0;
  const visit = (c) => { if (typeof c[0] === "number") { sx += c[0]; sy += c[1]; n++; } else c.forEach(visit); };
  visit(g.coordinates);
  return n ? [sx / n, sy / n] : null;
}
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inGeom(p, g) {
  if (!g) return false;
  if (g.type === "Polygon") return inRing(p, g.coordinates[0]) && !g.coordinates.slice(1).some((h) => inRing(p, h));
  if (g.type === "MultiPolygon") return g.coordinates.some((poly) => inGeom(p, { type: "Polygon", coordinates: poly }));
  return false;
}
function circle([lon, lat], meters, steps = 64) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + (meters / (R * Math.cos(rad(lat)))) * (180 / Math.PI) * Math.cos(a), lat + (meters / R) * (180 / Math.PI) * Math.sin(a)]);
  }
  return { type: "Polygon", coordinates: [ring] };
}
function lengthOf(g) {
  const line = (c) => c.slice(1).reduce((s, p, i) => s + haversine(c[i], p), 0);
  if (g.type === "LineString") return line(g.coordinates);
  if (g.type === "MultiLineString" || g.type === "Polygon") return g.coordinates.reduce((s, c) => s + line(c), 0);
  if (g.type === "MultiPolygon") return g.coordinates.reduce((s, p) => s + p.reduce((t, c) => t + line(c), 0), 0);
  return 0;
}
function areaOf(g) {
  const ring = (c) => {
    let s = 0;
    for (let i = 0; i < c.length - 1; i++) s += rad(c[i + 1][0] - c[i][0]) * (2 + Math.sin(rad(c[i][1])) + Math.sin(rad(c[i + 1][1])));
    return Math.abs((s * R * R) / 2);
  };
  if (g.type === "Polygon") return ring(g.coordinates[0]) - g.coordinates.slice(1).reduce((t, h) => t + ring(h), 0);
  if (g.type === "MultiPolygon") return g.coordinates.reduce((t, p) => t + areaOf({ type: "Polygon", coordinates: p }), 0);
  return 0;
}
const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);
const fmtA = (a) => (a >= 1e5 ? `${(a / 1e6).toFixed(2)} km²` : `${Math.round(a)} m²`);
const label = (f) => f.properties?.name || f.properties?.nom || f.properties?.label || f.properties?.titre || f.properties?.Titre || null;
const fc = (features) => ({ type: "FeatureCollection", features });

function compare(v, op, x) {
  const n = parseFloat(v), m = parseFloat(x);
  switch (op) {
    case "=": return String(v ?? "").toLowerCase() === String(x).toLowerCase();
    case "!=": return String(v ?? "").toLowerCase() !== String(x).toLowerCase();
    case "contient": return String(v ?? "").toLowerCase().includes(String(x).toLowerCase());
    case ">": return n > m; case "<": return n < m; case ">=": return n >= m; case "<=": return n <= m;
    case "existe": return v != null && v !== "";
    default: return false;
  }
}

// ---- Catalogue ------------------------------------------------------------------
// { name, cat, core?, desc, params:{nom: schéma}, req:[…], run(args, ctx) → string }
export function catalog() {
  const L = (ctx, ref) => {
    const l = ctx.findLayer(ref);
    if (!l) throw new Error(`Couche introuvable : « ${ref} ». Couches : ${ctx.layers.map((x) => `${x.id} (${x.name})`).join(", ") || "aucune"}.`);
    return l;
  };
  const summary = (l) => {
    const ex = l.data.features.map(label).filter(Boolean).slice(0, 5);
    return `couche ${l.id} « ${l.name} » : ${l.data.features.length} objets${ex.length ? ` (ex. ${ex.join(", ")})` : ""}`;
  };
  const center = async (ctx, place) => {
    if (!place) return ctx.map.getCenter().toArray();
    const h = (await geocode(place))[0];
    if (!h) throw new Error(`Lieu introuvable : ${place}`);
    return [h.lon, h.lat];
  };

  return [
    // ===== Navigation =====
    { name: "etat_carte", cat: "navigation", core: true, desc: "Vue actuelle, fond de carte, couches affichées (id, nom, nombre d'objets). À appeler d'abord si besoin.",
      params: {}, req: [], run: (_, ctx) => ctx.stateText() },
    { name: "aller_a", cat: "navigation", core: true, desc: "Centre la carte sur un lieu (ville, adresse, région, monument).",
      params: { lieu: T.str("Lieu à afficher") }, req: ["lieu"],
      run: async ({ lieu }, ctx) => { const h = await ctx.goTo(lieu); return `Carte centrée sur ${h.label}.`; } },
    { name: "definir_vue", cat: "navigation", desc: "Règle la vue précisément (longitude, latitude, zoom 0-20, inclinaison 0-85, orientation en degrés).",
      params: { lon: T.num("Longitude"), lat: T.num("Latitude"), zoom: T.num("Zoom"), inclinaison: T.num("Pitch"), orientation: T.num("Bearing") }, req: [],
      run: ({ lon, lat, zoom, inclinaison, orientation }, ctx) => {
        const c = ctx.map.getCenter();
        ctx.map.easeTo({ center: [lon ?? c.lng, lat ?? c.lat], zoom: zoom ?? ctx.map.getZoom(), pitch: inclinaison ?? ctx.map.getPitch(), bearing: orientation ?? ctx.map.getBearing() });
        return "Vue réglée.";
      } },
    { name: "zoomer_sur_couche", cat: "navigation", desc: "Cadre la carte sur l'emprise d'une couche.",
      params: { couche: T.str("id ou nom de couche") }, req: ["couche"],
      run: ({ couche }, ctx) => { const l = L(ctx, couche); ctx.fitTo(bboxOf(l.data)); return `Cadré sur ${l.name}.`; } },
    { name: "fond_de_carte", cat: "navigation", core: true, desc: "Change le fond : plan, osm, ortho (photos aériennes/satellite IGN), topo (plan IGN).",
      params: { fond: T.enum(["plan", "osm", "ortho", "topo"], "Fond") }, req: ["fond"],
      run: ({ fond }, ctx) => { ctx.setBasemap(fond); return `Fond : ${fond}.`; } },
    { name: "geocoder", cat: "navigation", desc: "Cherche les coordonnées d'un lieu sans déplacer la carte (5 résultats).",
      params: { lieu: T.str("Lieu") }, req: ["lieu"],
      run: async ({ lieu }) => (await geocode(lieu)).slice(0, 5).map((h) => `${h.label} → ${h.lat.toFixed(5)}, ${h.lon.toFixed(5)}`).join("\n") || "Aucun résultat." },

    // ===== Données =====
    { name: "extraire_osm", cat: "donnees", core: true, desc: "Extrait des objets OpenStreetMap (© contributeurs OSM, ODbL) dans la vue ou autour d'un lieu, en tags OSM exacts (ex. amenity=pharmacy, leisure=park, highway=cycleway, shop=bakery). value vide = toutes les valeurs.",
      params: { cle: T.str("Clé OSM, ex. amenity"), valeur: T.str("Valeur OSM, ex. pharmacy (vide = toutes)"), nom: T.str("Nom lisible de la couche"), lieu: T.str("Facultatif : lieu où se déplacer d'abord") }, req: ["cle", "nom"],
      run: async ({ cle, valeur, nom, lieu }, ctx) => {
        if (!/^[a-z_:]+$/i.test(cle || "") || /["\\]/.test(valeur || "")) throw new Error("Tag OSM invalide.");
        if (lieu) await ctx.goTo(lieu);
        const l = await ctx.extractOSM([{ key: cle, value: valeur || "" }], nom);
        return l ? summary(l) : `Aucun objet ${cle}=${valeur || "*"} dans cette zone.`;
      } },
    { name: "requete_overpass", cat: "donnees", desc: "Exécute une requête Overpass QL brute ; {{bbox}} est remplacé par l'emprise de la vue. Préférer extraire_osm.",
      params: { ql: T.str("Requête Overpass QL avec [out:json] et out geom"), nom: T.str("Nom de la couche") }, req: ["ql"],
      run: async ({ ql, nom }, ctx) => {
        const [w, s, e, n] = ctx.bbox();
        const data = await overpass(String(ql).replace(/\{\{bbox\}\}/g, `${s},${w},${n},${e}`));
        return summary(ctx.addLayer({ name: nom || "Requête Overpass", data, credit: OSM_CREDIT }));
      } },
    { name: "chercher_datagouv", cat: "donnees", core: true, desc: "Cherche des jeux de données géographiques ouverts sur data.gouv.fr. Rend une liste numérotée « jeu.ressource » à charger avec charger_datagouv.",
      params: { recherche: T.str("Mots-clés, ex. bornes de recharge") }, req: ["recherche"],
      run: async ({ recherche }, ctx) => {
        const list = await ctx.searchDatagouv(recherche);
        ctx.dgCache = list;
        return list.slice(0, 8).map((d, i) => `${i}. ${d.title} — ${d.org} (${datagouvCredit(d).license}) : ${d.resources.slice(0, 4).map((r, j) => `[${i}.${j}] ${r.format} ${String(r.title).slice(0, 30)}`).join(" ; ")}`).join("\n") || "Aucun jeu géographique.";
      } },
    { name: "charger_datagouv", cat: "donnees", core: true, desc: "Charge sur la carte une ressource trouvée par chercher_datagouv, désignée par « jeu.ressource » (ex. 0.1).",
      params: { ressource: T.str("Référence jeu.ressource, ex. 0.0") }, req: ["ressource"],
      run: async ({ ressource }, ctx) => {
        const [i, j] = String(ressource).split(".").map(Number);
        const d = ctx.dgCache?.[i], r = d?.resources?.[j || 0];
        if (!r) throw new Error("Référence inconnue : relancez chercher_datagouv.");
        const l = ctx.addLayer({ name: d.title, data: await loadResource(r), credit: datagouvCredit(d) });
        ctx.fitTo(bboxOf(l.data), 14);
        return summary(l);
      } },
    { name: "charger_url", cat: "donnees", desc: "Charge un GeoJSON, CSV (colonnes lat/lon) ou JSON depuis une URL http(s). Préciser la source et la licence si connues.",
      params: { url: T.str("URL"), nom: T.str("Nom de la couche"), source: T.str("Producteur de la donnée"), licence: T.str("Licence") }, req: ["url", "nom"],
      run: async ({ url, nom, source, licence }, ctx) => {
        if (!/^https?:\/\//i.test(url)) throw new Error("URL http(s) attendue.");
        const l = ctx.addLayer({ name: nom, data: await loadResource({ url }), credit: { source: source || new URL(url).hostname, license: licence || "non précisée", url } });
        ctx.fitTo(bboxOf(l.data), 14);
        return summary(l);
      } },
    { name: "ajouter_points", cat: "donnees", core: true, desc: "Ajoute des points créés par toi ou l'utilisateur (nouvelle couche ou couche existante). Chaque point : soit lat/lon, soit une adresse à géocoder, plus un nom et des attributs libres.",
      params: {
        couche: T.str("Nom de la nouvelle couche, ou id/nom d'une couche existante"),
        points: { type: "array", description: "Points", items: { type: "object", properties: { nom: T.str("Nom"), lat: T.num("Latitude"), lon: T.num("Longitude"), adresse: T.str("Adresse à géocoder si pas de lat/lon"), description: T.str("Description") }, required: ["nom"] } },
      }, req: ["couche", "points"],
      run: async ({ couche, points }, ctx) => {
        const feats = [], ko = [];
        let geocoded = false;
        for (const p of (points || []).slice(0, 200)) {
          let lon = Number(p.lon), lat = Number(p.lat);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            const h = p.adresse || p.nom ? (await geocode(p.adresse || p.nom))[0] : null;
            if (!h) { ko.push(p.nom); continue; }
            [lon, lat] = [h.lon, h.lat]; geocoded = true;
          }
          const { lat: _a, lon: _b, ...props } = p;
          feats.push({ type: "Feature", properties: { name: p.nom, ...props }, geometry: { type: "Point", coordinates: [lon, lat] } });
        }
        const credit = geocoded ? { source: "Saisie + géocodage BAN/Nominatim", license: "Licence Ouverte 2.0 / ODbL", url: BAN.url } : { source: "Saisie dans Lumen", license: "—", url: "" };
        const l = ctx.appendOrCreate(couche, feats, credit);
        ctx.fitTo(bboxOf(l.data), 15);
        return `${feats.length} point(s) ajouté(s) à ${summary(l)}${ko.length ? `. Non localisés : ${ko.join(", ")}` : ""}`;
      } },
    { name: "tracer_ligne", cat: "donnees", desc: "Ajoute une ligne ou un polygone à partir d'une suite de lieux ou de coordonnées [lon,lat].",
      params: { couche: T.str("Couche"), nom: T.str("Nom de l'objet"), etapes: T.list("Lieux ou « lon,lat »"), ferme: T.bool("true = polygone") }, req: ["couche", "etapes"],
      run: async ({ couche, nom, etapes, ferme }, ctx) => {
        const pts = [];
        for (const e of etapes || []) {
          const m = String(e).match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
          if (m) pts.push([Number(m[1]), Number(m[2])]);
          else { const h = (await geocode(e))[0]; if (h) pts.push([h.lon, h.lat]); }
        }
        if (pts.length < 2) throw new Error("Au moins deux étapes localisables.");
        const geometry = ferme ? { type: "Polygon", coordinates: [[...pts, pts[0]]] } : { type: "LineString", coordinates: pts };
        const l = ctx.appendOrCreate(couche, [{ type: "Feature", properties: { name: nom || couche }, geometry }], { source: "Saisie dans Lumen", license: "—", url: "" });
        ctx.fitTo(bboxOf(l.data));
        return `${ferme ? "Polygone" : "Ligne"} de ${fmtM(lengthOf(geometry))} ajouté(e) à ${l.name}.`;
      } },
    { name: "contour_commune", cat: "donnees", desc: "Ajoute le contour officiel d'une commune, d'un département ou d'une région française (geo.api.gouv.fr).",
      params: { nom: T.str("Nom"), niveau: T.enum(["commune", "departement", "region"], "Niveau") }, req: ["nom"],
      run: async ({ nom, niveau = "commune" }, ctx) => {
        const ep = { commune: "communes", departement: "departements", region: "regions" }[niveau] || "communes";
        const r = await fetch(`https://geo.api.gouv.fr/${ep}?nom=${encodeURIComponent(nom)}&fields=nom,code,population,contour&format=geojson&geometry=contour&limit=1`);
        const data = await r.json();
        if (!data.features?.length) throw new Error(`Aucun(e) ${niveau} « ${nom} ».`);
        const l = ctx.addLayer({ name: `Contour ${data.features[0].properties.nom}`, data, credit: GEOAPI });
        ctx.fitTo(bboxOf(l.data));
        const f = data.features[0];
        return `Contour de ${f.properties.nom} (${f.properties.code}${f.properties.population ? `, ${f.properties.population} hab.` : ""}, ${fmtA(areaOf(f.geometry))}) → couche ${l.id}.`;
      } },

    // ===== Itinéraires (IGN) =====
    { name: "itineraire", cat: "itineraires", core: true, desc: "Itinéraire routier (France, IGN) entre un départ et une arrivée, avec étapes facultatives (ordre optimisable, boucle), en voiture, à pied ou à vélo (estimé). Trace la route et rend distance, durée et instructions pas à pas.",
      params: { depart: T.str("Départ (lieu, adresse ou « lat, lon »)"), arrivee: T.str("Arrivée"), etapes: T.list("Étapes intermédiaires (facultatif)"), mode: T.enum(["car", "pedestrian", "bike"], "Mode"), optimiser: T.bool("Réordonner les étapes pour le trajet le plus court"), boucle: T.bool("Revenir au départ") }, req: ["depart", "arrivee"],
      run: async ({ depart, arrivee, etapes = [], mode = "car", optimiser, boucle }, ctx) => {
        const places = [];
        for (const s of [depart, ...(etapes || []), arrivee]) places.push(await resolvePlace(s, ctx));
        const r = await route(places.map((p) => p.coord), { mode, optimize: !!optimiser, loop: !!boucle, lang: ctx.lang?.() || "fr" });
        const order = r.order.map((i) => places[i]);
        const seq = boucle ? [...order, order[0]] : order;
        const props = { name: `${seq[0].label} → ${seq.at(-1).label}`, distance_m: Math.round(r.distance), duree_min: Math.round(r.duration), mode };
        const stops = seq.map((p, i) => pointOf(p.coord, { name: p.label, ordre: i }));
        const l = ctx.addLayer({ name: `Itinéraire ${props.name}`, data: fcOf([{ type: "Feature", properties: props, geometry: r.geometry }, ...stops]), credit: IGN_CREDIT });
        ctx.fitTo(bboxGeo(l.data));
        const steps = r.steps.filter((s) => s.distance > 60).slice(0, 12).map((s, i) => `${i + 1}. ${s.text} (${fmtM(s.distance)})`).join("\n");
        return `${routeSummary(r)} → couche ${l.id}.${r.order.some((v, i) => v !== i) ? ` Ordre : ${order.map((p) => p.label).join(" → ")}.` : ""}${r.legs.length > 1 ? `\nTronçons : ${r.legs.map((g) => `${fmtM(g.distance)}/${fmtMin(g.duration)}`).join(", ")}` : ""}\n${steps}`;
      } },
    { name: "isochrone", cat: "itineraires", desc: "Zone atteignable depuis un lieu en N minutes ou N mètres (voiture, à pied ou vélo estimé), IGN.",
      params: { lieu: T.str("Lieu de départ"), minutes: T.num("Durée en minutes"), metres: T.num("OU distance en mètres"), mode: T.enum(["car", "pedestrian", "bike"], "Mode") }, req: ["lieu"],
      run: async ({ lieu, minutes, metres, mode = "pedestrian" }, ctx) => {
        const p = await resolvePlace(lieu, ctx);
        if (minutes == null && metres == null) minutes = 15;
        const g = await isoline(p.coord, { minutes: metres != null ? undefined : minutes, meters: metres, mode });
        const what = metres != null ? fmtM(metres) : `${minutes} min`;
        const l = ctx.addLayer({ name: `${what} ${mode === "car" ? "en voiture" : mode === "bike" ? "à vélo" : "à pied"} de ${p.label}`, data: fc([{ type: "Feature", properties: { name: p.label, surface_m2: Math.round(areaOf(g)) }, geometry: g }]), credit: IGN_CREDIT });
        ctx.fitTo(bboxOf(l.data));
        return `Zone accessible de ${fmtA(areaOf(g))} → couche ${l.id}.`;
      } },
    { name: "matrice_distances", cat: "itineraires", desc: "Tableau des distances (et durées si routier) entre plusieurs lieux : à vol d'oiseau, ou par la route (IGN, 8 lieux au plus).",
      params: { lieux: T.list("Lieux (2 à 12)"), routier: T.bool("true = par la route"), mode: T.enum(["car", "pedestrian", "bike"], "Mode routier") }, req: ["lieux"],
      run: async ({ lieux, routier, mode = "car" }, ctx) => {
        const P = [];
        for (const s of (lieux || []).slice(0, routier ? 8 : 12)) P.push(await resolvePlace(s, ctx));
        if (P.length < 2) throw new Error("Au moins deux lieux.");
        const m = await matrix(P.map((p) => p.coord), P.map((p) => p.coord), { road: !!routier, mode });
        const head = P.map((p, i) => `${i + 1}=${p.label}`).join(" ; ");
        const rows = m.map((row, i) => `${i + 1} : ${row.map((c, j) => (i === j ? "—" : c.distance == null ? "?" : `${j + 1}:${fmtM(c.distance)}${c.duration != null ? `/${fmtMin(c.duration)}` : ""}`)).join("  ")}`);
        return `${routier ? "Par la route" : "À vol d'oiseau"}. ${head}\n${rows.join("\n")}`;
      } },
    { name: "carte_pdf", cat: "export", core: true, desc: "Génère une carte de localisation PDF (plan d'accès) d'un lieu : repères proches avec distances et directions, échelle, nord, carte de situation, coordonnées, et itinéraire depuis un point si demandé. Enregistrée dans Cartes/.",
      params: { lieu: T.str("Lieu à localiser (adresse, établissement, « lat, lon »)"), depuis: T.str("Facultatif : point de départ de l'itinéraire (gare, ville…)"), titre: T.str("Facultatif : titre"), format: T.enum(["paysage", "portrait"], "Format A4"), mode: T.enum(["car", "pedestrian", "bike"], "Mode de l'itinéraire") }, req: ["lieu"],
      run: async ({ lieu, depuis, titre, format, mode }, ctx) => makePdf(ctx, { lieu, depuis, titre, format, mode }, (s) => ctx.busy?.(s)) },
    { name: "direction", cat: "analyse", desc: "Distance, cap (degrés) et direction cardinale d'un lieu A vers un lieu B.",
      params: { de: T.str("Lieu A"), vers: T.str("Lieu B") }, req: ["de", "vers"],
      run: async ({ de, vers }, ctx) => { const a = await resolvePlace(de, ctx), b = await resolvePlace(vers, ctx); const c = capOf(a.coord, b.coord); return `${b.label} est à ${fmtM(haversine(a.coord, b.coord))} au ${cardinal(c)} de ${a.label} (cap ${Math.round(c)}°).`; } },
    // Géotraitements façon Turf (mêmes opérations que l'onglet SIG).
    ...OPS.map((op) => ({
      name: `sig_${op.id}`, cat: "sig", desc: `${op.label} : ${op.desc}`,
      params: Object.fromEntries(op.fields.map((f) => [f.k, f.type === "layer" ? T.str(`${f.label} — id ou nom de couche`) : f.type === "num" ? T.num(f.label) : f.type === "bool" ? T.bool(f.label) : f.type === "select" ? T.enum(f.opts.map(([v]) => v), f.label) : T.str(f.label)])),
      req: op.fields.filter((f) => !f.opt && f.def == null).map((f) => f.k),
      run: (args, ctx) => runOp(op.id, args, ctx),
    })),

    // ===== Couches =====
    { name: "decrire_couche", cat: "couches", core: true, desc: "Résumé d'une couche : nombre d'objets, types de géométrie, attributs disponibles, exemples, source.",
      params: { couche: T.str("id ou nom") }, req: ["couche"],
      run: ({ couche }, ctx) => {
        const l = L(ctx, couche);
        const types = {}, keys = {};
        for (const f of l.data.features) { types[f.geometry?.type] = (types[f.geometry?.type] || 0) + 1; for (const k of Object.keys(f.properties || {})) keys[k] = (keys[k] || 0) + 1; }
        const top = Object.entries(keys).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => `${k}(${n})`);
        return `${summary(l)}\nGéométries : ${Object.entries(types).map(([t, n]) => `${t} ${n}`).join(", ")}\nAttributs : ${top.join(", ")}\nSource : ${l.credit ? `${l.credit.source} — ${l.credit.license}` : "?"}`;
      } },
    { name: "statistiques", cat: "couches", desc: "Répartition des valeurs d'un attribut (10 plus fréquentes) ou min/max/moyenne s'il est numérique.",
      params: { couche: T.str("Couche"), attribut: T.str("Attribut") }, req: ["couche", "attribut"],
      run: ({ couche, attribut }, ctx) => {
        const vals = L(ctx, couche).data.features.map((f) => f.properties?.[attribut]).filter((v) => v != null && v !== "");
        if (!vals.length) return `Attribut « ${attribut} » vide ou absent.`;
        const nums = vals.map(Number).filter(Number.isFinite);
        if (nums.length > vals.length * 0.8) return `${nums.length} valeurs : min ${Math.min(...nums)}, max ${Math.max(...nums)}, moyenne ${(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)}, somme ${nums.reduce((a, b) => a + b, 0)}`;
        const c = {};
        for (const v of vals) c[v] = (c[v] || 0) + 1;
        return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v, n]) => `${v} : ${n}`).join("\n");
      } },
    { name: "chercher_objets", cat: "couches", desc: "Liste (max 15) les objets d'une couche dont un attribut correspond (opérateurs =, !=, contient, >, <, >=, <=, existe).",
      params: { couche: T.str("Couche"), attribut: T.str("Attribut"), operateur: T.enum(["=", "!=", "contient", ">", "<", ">=", "<=", "existe"], "Opérateur"), valeur: T.str("Valeur") }, req: ["couche", "attribut", "operateur"],
      run: ({ couche, attribut, operateur, valeur }, ctx) => {
        const hits = L(ctx, couche).data.features.filter((f) => compare(f.properties?.[attribut], operateur, valeur));
        return `${hits.length} objet(s).\n${hits.slice(0, 15).map((f) => `- ${label(f) || "(sans nom)"} ${attribut}=${f.properties?.[attribut] ?? ""}`).join("\n")}`;
      } },
    { name: "filtrer_couche", cat: "couches", desc: "Crée une nouvelle couche avec les objets d'une couche qui satisfont une condition sur un attribut.",
      params: { couche: T.str("Couche"), attribut: T.str("Attribut"), operateur: T.enum(["=", "!=", "contient", ">", "<", ">=", "<=", "existe"], "Opérateur"), valeur: T.str("Valeur"), nom: T.str("Nom du résultat") }, req: ["couche", "attribut", "operateur"],
      run: ({ couche, attribut, operateur, valeur, nom }, ctx) => {
        const l = L(ctx, couche);
        const out = l.data.features.filter((f) => compare(f.properties?.[attribut], operateur, valeur));
        return summary(ctx.addLayer({ name: nom || `${l.name} (${attribut} ${operateur} ${valeur ?? ""})`, data: fc(out), credit: l.credit }));
      } },
    { name: "styler_couche", cat: "couches", desc: "Change la couleur (hex) d'une couche, la renomme, l'affiche ou la masque.",
      params: { couche: T.str("Couche"), couleur: T.str("#rrggbb"), nom: T.str("Nouveau nom"), visible: T.bool("Visible") }, req: ["couche"],
      run: ({ couche, couleur, nom, visible }, ctx) => {
        const l = L(ctx, couche);
        ctx.updateLayer(l, { ...(couleur && /^#[0-9a-f]{6}$/i.test(couleur) ? { color: couleur } : {}), ...(nom ? { name: nom } : {}), ...(typeof visible === "boolean" ? { visible } : {}) });
        return `Couche ${l.id} mise à jour.`;
      } },
    { name: "supprimer_couche", cat: "couches", desc: "Retire une couche de la carte.",
      params: { couche: T.str("Couche") }, req: ["couche"],
      run: ({ couche }, ctx) => { const l = L(ctx, couche); ctx.removeLayer(l); return `Couche « ${l.name} » retirée.`; } },
    { name: "fusionner_couches", cat: "couches", desc: "Réunit plusieurs couches en une seule (les crédits sont cumulés dans les attributs).",
      params: { couches: T.list("ids ou noms"), nom: T.str("Nom du résultat") }, req: ["couches", "nom"],
      run: ({ couches, nom }, ctx) => {
        const ls = (couches || []).map((c) => L(ctx, c));
        const feats = ls.flatMap((l) => l.data.features.map((f) => ({ ...f, properties: { ...f.properties, "@source": l.credit?.source || "", "@layer": l.name } })));
        const credit = { source: [...new Set(ls.map((l) => l.credit?.source).filter(Boolean))].join(" ; "), license: [...new Set(ls.map((l) => l.credit?.license).filter(Boolean))].join(" ; "), url: ls[0]?.credit?.url || "" };
        return summary(ctx.addLayer({ name: nom, data: fc(feats), credit }));
      } },

    // ===== Analyse =====
    { name: "tampon", cat: "analyse", desc: "Zone tampon circulaire (rayon en mètres) autour d'un lieu ou de chaque point d'une couche (max 300).",
      params: { rayon_m: T.num("Rayon en mètres"), lieu: T.str("Lieu (ou vide)"), couche: T.str("Couche de points (ou vide)") }, req: ["rayon_m"],
      run: async ({ rayon_m, lieu, couche }, ctx) => {
        const centers = couche ? L(ctx, couche).data.features.slice(0, 300).map((f) => [centroid(f.geometry), label(f)]) : [[await center(ctx, lieu), lieu || "centre"]];
        const feats = centers.filter(([c]) => c).map(([c, n]) => ({ type: "Feature", properties: { name: `${n || ""} — ${fmtM(rayon_m)}`, rayon_m }, geometry: circle(c, Number(rayon_m)) }));
        const l = ctx.addLayer({ name: `Tampon ${fmtM(rayon_m)}${lieu ? ` autour de ${lieu}` : couche ? ` (${couche})` : ""}`, data: fc(feats), credit: null });
        ctx.fitTo(bboxOf(l.data));
        return summary(l);
      } },
    { name: "plus_proches", cat: "analyse", desc: "Les N objets d'une couche les plus proches d'un lieu, avec distances.",
      params: { couche: T.str("Couche"), lieu: T.str("Lieu de référence (vide = centre de la vue)"), n: T.int("Nombre (défaut 5)") }, req: ["couche"],
      run: async ({ couche, lieu, n = 5 }, ctx) => {
        const p = await center(ctx, lieu);
        const ranked = L(ctx, couche).data.features.map((f) => [f, haversine(p, centroid(f.geometry) || p)]).sort((a, b) => a[1] - b[1]).slice(0, Math.min(30, n));
        return ranked.map(([f, d], i) => `${i + 1}. ${label(f) || "(sans nom)"} — ${fmtM(d)}`).join("\n") || "Couche vide.";
      } },
    { name: "compter_dans_zone", cat: "analyse", desc: "Compte les objets d'une couche situés dans les polygones d'une autre couche (ou à moins de rayon_m d'un lieu). Peut créer la couche du résultat.",
      params: { couche: T.str("Couche à compter"), zones: T.str("Couche de polygones (ou vide)"), lieu: T.str("Lieu (si pas de zones)"), rayon_m: T.num("Rayon (si lieu)"), creer_couche: T.bool("Créer une couche des objets retenus") }, req: ["couche"],
      run: async ({ couche, zones, lieu, rayon_m, creer_couche }, ctx) => {
        const l = L(ctx, couche);
        let test, what;
        if (zones) { const z = L(ctx, zones).data.features; test = (p) => z.some((f) => inGeom(p, f.geometry)); what = `dans ${zones}`; }
        else { const c = await center(ctx, lieu); const r = Number(rayon_m) || 1000; test = (p) => haversine(c, p) <= r; what = `à moins de ${fmtM(r)} de ${lieu || "la vue"}`; }
        const hits = l.data.features.filter((f) => { const c = centroid(f.geometry); return c && test(c); });
        if (creer_couche) ctx.addLayer({ name: `${l.name} ${what}`, data: fc(hits), credit: l.credit });
        return `${hits.length} / ${l.data.features.length} objets ${what}.`;
      } },
    { name: "compter_par_zone", cat: "analyse", desc: "Pour chaque polygone d'une couche de zones, compte les objets d'une autre couche qu'il contient (ajoute l'attribut « nb » aux zones).",
      params: { zones: T.str("Couche de polygones"), couche: T.str("Couche à compter") }, req: ["zones", "couche"],
      run: ({ zones, couche }, ctx) => {
        const z = L(ctx, zones), pts = L(ctx, couche).data.features.map((f) => centroid(f.geometry)).filter(Boolean);
        for (const f of z.data.features) f.properties = { ...f.properties, nb: pts.filter((p) => inGeom(p, f.geometry)).length };
        ctx.updateLayer(z, {});
        return z.data.features.slice().sort((a, b) => b.properties.nb - a.properties.nb).slice(0, 10).map((f) => `${label(f) || "zone"} : ${f.properties.nb}`).join("\n");
      } },
    { name: "mesurer", cat: "analyse", desc: "Distance à vol d'oiseau entre deux lieux, ou longueur/superficie totale d'une couche.",
      params: { de: T.str("Lieu A"), a: T.str("Lieu B"), couche: T.str("Couche (au lieu de A/B)") }, req: [],
      run: async ({ de, a, couche }, ctx) => {
        if (couche) { const l = L(ctx, couche); const len = l.data.features.reduce((s, f) => s + lengthOf(f.geometry), 0); const ar = l.data.features.reduce((s, f) => s + areaOf(f.geometry), 0); return `Longueur totale ${fmtM(len)}${ar ? `, superficie ${fmtA(ar)}` : ""}.`; }
        return `${fmtM(haversine(await center(ctx, de), await center(ctx, a)))} à vol d'oiseau.`;
      } },
    { name: "densite", cat: "analyse", desc: "Affiche une couche de points en carte de chaleur (ou revient aux points).",
      params: { couche: T.str("Couche"), active: T.bool("true = chaleur") }, req: ["couche"],
      run: ({ couche, active = true }, ctx) => { const l = L(ctx, couche); ctx.updateLayer(l, { heat: !!active }); return `Carte de chaleur ${active ? "activée" : "désactivée"} pour ${l.name}.`; } },

    // ===== Export =====
    { name: "exporter", cat: "export", desc: "Exporte des couches en GeoJSON (avec crédits et fichier -SOURCES.txt) dans le dossier Cartes/ de la sandbox.",
      params: { couches: T.list("ids ou noms (vide = couches visibles)") }, req: [],
      run: async ({ couches }, ctx) => ctx.exportLayers((couches || []).length ? couches.map((c) => L(ctx, c)) : undefined) },
    { name: "capture_carte", cat: "export", desc: "Enregistre une image PNG de la carte dans Cartes/ (crédits dans le nom du fichier compagnon).",
      params: { nom: T.str("Nom du fichier") }, req: [], run: ({ nom }, ctx) => ctx.snapshot(nom) },

  ];
}

export const CATEGORIES = {
  navigation: "vue, déplacement, fonds, géocodage",
  donnees: "OSM, Overpass, data.gouv, URL, points/lignes saisis, contours administratifs",
  itineraires: "itinéraire multi-étapes optimisé, zone accessible, matrice de distances (IGN)",
  sig: "géotraitements façon Turf : tampon, enveloppe, centroïdes, centre moyen, emprise, simplification, mesures, objets dans zones, jointure spatiale, comptage par zone, plus proche voisin, liaisons, grille hex/carrée, k-moyennes, DBSCAN, découpe, intersections, jalons, interpolation IDW",
  couches: "décrire, statistiques, chercher, filtrer, styler, fusionner, supprimer",
  analyse: "tampon, plus proches, comptage dans zone/par zone, mesures, carte de chaleur",
  export: "GeoJSON crédité, capture PNG, carte de localisation PDF",
};

const asTool = (t) => tool(t.name, t.desc, t.params, t.req);

/** Outils présentés au modèle : le niveau 1 + les deux méta-outils du niveau 2. */
export function toolDeck(all) {
  return [
    ...all.filter((t) => t.core).map(asTool),
    tool("lister_outils", `Affiche les outils avancés d'une catégorie (nom, description, paramètres). Catégories : ${Object.entries(CATEGORIES).map(([k, v]) => `${k} (${v})`).join(" ; ")}.`,
      { categorie: T.enum(Object.keys(CATEGORIES), "Catégorie") }, ["categorie"]),
    tool("executer_outil", "Exécute un outil avancé découvert avec lister_outils.",
      { nom: T.str("Nom exact de l'outil"), arguments: { type: "object", description: "Arguments de l'outil" } }, ["nom"]),
  ];
}

/** Exécution d'un appel (niveau 1 ou méta-outil). */
export async function runTool(all, name, args, ctx) {
  if (name === "lister_outils") {
    const list = all.filter((t) => t.cat === args.categorie);
    if (!list.length) return `Catégorie inconnue. Catégories : ${Object.keys(CATEGORIES).join(", ")}.`;
    return list.map((t) => `${t.name}(${Object.entries(t.params).map(([k, v]) => `${k}${t.req.includes(k) ? "" : "?"}: ${v.enum ? v.enum.join("|") : v.type}`).join(", ")}) — ${t.desc}`).join("\n");
  }
  if (name === "executer_outil") {
    let a = args.arguments;
    if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
    return runTool(all, args.nom, a || {}, ctx);
  }
  const t = all.find((x) => x.name === name);
  if (!t) return `Outil inconnu « ${name} ». Utilise lister_outils pour voir les outils d'une catégorie.`;
  const missing = t.req.filter((k) => args?.[k] == null || args[k] === "");
  if (missing.length) return `Paramètre(s) manquant(s) pour ${name} : ${missing.join(", ")}.`;
  ctx.onTool?.(name, args);
  const out = String(await t.run(args || {}, ctx));
  return out.length > 1800 ? `${out.slice(0, 1800)}…` : out;
}
