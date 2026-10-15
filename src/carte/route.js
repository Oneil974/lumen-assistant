// Itinéraires de Carte (IGN Géoplateforme, France) : étapes intermédiaires,
// instructions pas à pas en clair, tournée optimisée et matrice de distances.
//
// L'API IGN ne connaît que la voiture et le piéton ; le vélo est estimé à partir
// de l'itinéraire piéton (même réseau, ~15 km/h) — signalé comme tel.

import { distance, optimizeOrder, fmtM, fmtMin } from "./geo.js";

export const IGN_CREDIT = { source: "IGN – Géoplateforme (itinéraire)", license: "Licence Ouverte 2.0", licenseUrl: "https://www.etalab.gouv.fr/licence-ouverte-open-licence/", url: "https://geoservices.ign.fr/services-geoplateforme-itineraire" };
const BASE = "https://data.geopf.fr/navigation";
const BIKE_KMH = 15;

// « R DE BONNEL » → « rue de Bonnel »
const ABBR = { R: "rue", AV: "avenue", BD: "boulevard", PL: "place", QU: "quai", QUAI: "quai", CHE: "chemin", CHEM: "chemin", RTE: "route", IMP: "impasse", ALL: "allée", CRS: "cours", PAS: "passage", SQ: "square", ESP: "esplanade", PROM: "promenade", RPT: "rond-point", VC: "voie communale", D: "D", N: "N", A: "A", MTE: "montée", SEN: "sentier", TRA: "traverse", CAR: "carrefour", PONT: "pont", FG: "faubourg", PRV: "parvis", RLE: "ruelle", LOT: "lotissement", HAM: "hameau", LD: "lieu-dit" };
const SMALL = new Set(["de", "du", "des", "la", "le", "les", "l", "d", "et", "à", "au", "aux", "en", "sur", "sous"]);
export function prettyStreet(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  if (/^[ADN]\s?\d/i.test(t)) return t.toUpperCase().replace(/\s+/g, ""); // D906, N7, A6
  const words = t.toLowerCase().split(/\s+/);
  const first = ABBR[words[0].toUpperCase()];
  return words.map((w, i) => {
    if (i === 0 && first) return first;
    if (i > 0 && SMALL.has(w)) return w;
    if (/^[ivxlc]+$/.test(w) && w.length < 5 && i > 0) return w.toUpperCase();
    return w.replace(/(^|[-'’])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  }).join(" ").replace(/\b(d|l) (?=[aeiouyhàâéèêîôû])/gi, "$1’");
}
const streetOf = (st) => { const n = st.attributes?.name || {}; return prettyStreet(n.nom_1_droite || n.nom_1_gauche || n.cpx_toponyme || ""); };

const TURN = {
  fr: { left: "tournez à gauche", right: "tournez à droite", "slight left": "serrez à gauche", "slight right": "serrez à droite", "sharp left": "tournez franchement à gauche", "sharp right": "tournez franchement à droite", straight: "continuez tout droit", uturn: "faites demi-tour" },
  en: { left: "turn left", right: "turn right", "slight left": "bear left", "slight right": "bear right", "sharp left": "turn sharp left", "sharp right": "turn sharp right", straight: "continue straight", uturn: "make a U-turn" },
};
/** Instruction IGN (type/modifier OSRM) → phrase. */
function phrase(st, lang = "fr") {
  const t = st.instruction?.type, m = st.instruction?.modifier || "straight", street = streetOf(st);
  const on = street ? (lang === "en" ? ` onto ${street}` : ` sur ${street}`) : "";
  const T = TURN[lang] || TURN.fr;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  switch (t) {
    case "depart": return lang === "en" ? `Start${street ? ` on ${street}` : ""}` : `Partez${street ? ` par ${street}` : ""}`;
    case "arrive": return lang === "en" ? "Arrive at destination" : "Vous êtes arrivé";
    case "roundabout": case "rotary": case "roundabout turn": {
      const ex = st.instruction?.exit;
      return lang === "en" ? `At the roundabout, take ${ex ? `exit ${ex}` : "the exit"}${on}` : `Au rond-point, prenez ${ex ? `la ${ex === 1 ? "1re" : `${ex}e`} sortie` : "la sortie"}${on}`;
    }
    case "new name": case "continue": return lang === "en" ? `Continue${on}` : `Continuez${on}`;
    case "merge": return lang === "en" ? `Merge${on}` : `Insérez-vous${on}`;
    case "on ramp": return lang === "en" ? `Take the ramp${on}` : `Prenez la bretelle${on}`;
    case "off ramp": return lang === "en" ? `Take the exit${on}` : `Prenez la sortie${on}`;
    case "fork": return cap(`${lang === "en" ? "at the fork, " : "à l’embranchement, "}${T[m] || T.straight}${on}`);
    case "end of road": return cap(`${lang === "en" ? "at the end of the road, " : "au bout de la route, "}${T[m] || T.straight}${on}`);
    default: return cap(`${T[m] || T.straight}${on}`);
  }
}

/**
 * Itinéraire passant par des étapes [lon,lat] (2 à 15 points).
 * @param {{ mode?: "car"|"pedestrian"|"bike", optimization?: "fastest"|"shortest", optimize?: boolean, loop?: boolean, lang?: string }} o
 * @returns {Promise<{ geometry, distance, duration, order, legs, steps:[{text, distance, duration}], mode, estimated? }>}
 */
export async function route(points, o = {}) {
  if (points.length < 2) throw new Error("Au moins deux points.");
  if (points.length > 15) throw new Error("15 étapes au maximum.");
  const mode = o.mode || "car";
  let order = points.map((_, i) => i);
  if (o.optimize && points.length > 3) order = optimizeOrder(points, { loop: !!o.loop, keepLast: !o.loop });
  let seq = order.map((i) => points[i]);
  if (o.loop) seq = [...seq, seq[0]];
  const profile = mode === "car" ? "car" : "pedestrian";
  const q = new URLSearchParams({
    resource: "bdtopo-osrm", start: seq[0].join(","), end: seq.at(-1).join(","), profile,
    optimization: o.optimization || "fastest", getSteps: "true", geometryFormat: "geojson", distanceUnit: "meter", timeUnit: "minute",
  });
  if (seq.length > 2) q.set("intermediates", seq.slice(1, -1).map((p) => p.join(",")).join("|"));
  const r = await fetch(`${BASE}/itineraire?${q}`);
  const d = await r.json().catch(() => ({}));
  if (!d.geometry) throw new Error(d.error?.message || d.message || "Itinéraire impossible (hors de France ?).");
  const lang = o.lang || "fr";
  const kmh = mode === "bike" ? BIKE_KMH : null;
  const dur = (dist, min) => (kmh ? (dist / 1000 / kmh) * 60 : min);
  const legs = (d.portions || []).map((p) => ({ distance: p.distance, duration: dur(p.distance, p.duration) }));
  const steps = [];
  for (const p of d.portions || []) for (const st of p.steps || []) {
    const text = phrase(st, lang);
    const prev = steps.at(-1);
    // Les « continuez » successifs sur la même voie sont fusionnés.
    if (prev && /^(Continuez|Continue)/.test(text) && prev.text.endsWith(text.replace(/^(Continuez|Continue)/, "").trim()) && text.replace(/^(Continuez|Continue)/, "").trim()) {
      prev.distance += st.distance; prev.duration += dur(st.distance, st.duration); continue;
    }
    steps.push({ text, distance: st.distance, duration: dur(st.distance, st.duration) });
  }
  return { geometry: d.geometry, distance: d.distance, duration: dur(d.distance, d.duration), order, legs, steps, mode, estimated: !!kmh };
}

/** Zone accessible en `minutes` (isochrone) ou en `meters` (isodistance). */
export async function isoline(p, { minutes, meters, mode = "pedestrian" } = {}) {
  const profile = mode === "car" ? "car" : "pedestrian";
  const byTime = minutes != null;
  let cost = byTime ? Number(minutes) : Number(meters);
  // Vélo : isodistance équivalente sur le réseau piéton.
  if (mode === "bike" && byTime) { cost = (Number(minutes) / 60) * BIKE_KMH * 1000; }
  const timeMode = byTime && mode !== "bike";
  const q = new URLSearchParams({ resource: "bdtopo-valhalla", point: p.join(","), costValue: String(cost), costType: timeMode ? "time" : "distance", profile, ...(timeMode ? { timeUnit: "minute" } : { distanceUnit: "meter" }), geometryFormat: "geojson" });
  const r = await fetch(`${BASE}/isochrone?${q}`);
  const d = await r.json().catch(() => ({}));
  if (!d.geometry) throw new Error(d.error?.message || d.message || "Isochrone impossible.");
  return d.geometry;
}

/**
 * Matrice origine × destination. `road` : distances/durées routières (IGN,
 * un appel par paire, 64 paires au plus) ; sinon à vol d'oiseau.
 */
export async function matrix(origins, dests, { road = false, mode = "car" } = {}) {
  if (road && origins.length * dests.length > 64) throw new Error("64 trajets routiers au maximum : réduisez la liste ou utilisez le vol d'oiseau.");
  const out = [];
  for (const a of origins) {
    const row = [];
    for (const b of dests) {
      if (!road) { row.push({ distance: distance(a, b), duration: null }); continue; }
      try { const r = await route([a, b], { mode }); row.push({ distance: r.distance, duration: r.duration }); }
      catch { row.push({ distance: null, duration: null }); }
    }
    out.push(row);
  }
  return out;
}

export const routeSummary = (r, lang = "fr") => `${fmtM(r.distance)}, ${fmtMin(r.duration)}${r.estimated ? (lang === "en" ? " (bike, estimated)" : " (vélo, estimé)") : ""}`;
