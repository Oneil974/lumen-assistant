// Carte de localisation en PDF (A4 paysage ou portrait).
//
// Les éléments de navigation sont CALCULÉS, jamais inventés :
//   - coordonnées (décimales + DMS), commune et département (geo.api.gouv.fr) ;
//   - repères proches tirés d'OpenStreetMap (gare, arrêts, parkings, mairie…),
//     avec leur distance et leur direction depuis le lieu ;
//   - itinéraire IGN depuis un point de départ (instructions pas à pas) ;
//   - échelle graphique et flèche du nord calculées pour l'emprise imprimée,
//     carte de situation à petite échelle avec le cadre de la carte principale.
// L'IA ne fait que RÉDIGER (titre, paragraphe « Accès », repères en phrases)
// à partir de ces faits ; sans IA, un texte déterministe les reprend.

import { geocode, overpass, BASEMAPS, OSM_CREDIT } from "./sources.js";
import { distance, bearing, cardinal, bbox as bboxOf, fmtM, fmtMin, dms, fc, point } from "./geo.js";
import { route, IGN_CREDIT } from "./route.js";
import { llmChat } from "../llm.js";

const LANDMARK_QL = (lat, lon, r) => `[out:json][timeout:25];
(
  nwr(around:${r},${lat},${lon})[railway~"^(station|halt|tram_stop)$"][name];
  nwr(around:${r},${lat},${lon})[public_transport=station][name];
  node(around:${r},${lat},${lon})[highway=bus_stop][name];
  nwr(around:${r},${lat},${lon})[amenity~"^(parking|townhall|hospital|police|post_office|pharmacy|place_of_worship|school|library|marketplace|fuel)$"];
  nwr(around:${r},${lat},${lon})[tourism~"^(museum|attraction|hotel|information)$"][name];
  nwr(around:${r},${lat},${lon})[leisure~"^(park|stadium)$"][name];
  nwr(around:${r},${lat},${lon})[shop=supermarket][name];
);
out geom 300;`;

// Priorité d'un repère pour s'orienter (plus haut = plus utile).
const KINDS = [
  [(t) => t.station === "subway" || t.subway === "yes" || t.railway === "subway_entrance", 9, "station de métro", "metro station"],
  [(t) => /station|halt/.test(t.railway || "") || t.public_transport === "station", 10, "gare", "station"],
  [(t) => t.railway === "tram_stop", 8, "arrêt de tram", "tram stop"],
  [(t) => t.highway === "bus_stop", 7, "arrêt de bus", "bus stop"],
  [(t) => t.amenity === "parking", 7, "parking", "car park"],
  [(t) => t.amenity === "townhall", 9, "mairie", "town hall"],
  [(t) => t.amenity === "hospital", 8, "hôpital", "hospital"],
  [(t) => t.tourism === "museum" || t.tourism === "attraction", 7, "monument / musée", "landmark"],
  [(t) => t.amenity === "place_of_worship", 6, "lieu de culte", "place of worship"],
  [(t) => t.leisure === "park" || t.leisure === "stadium", 6, t => (t.leisure === "park" ? "parc" : "stade"), t => (t.leisure === "park" ? "park" : "stadium")],
  [(t) => t.amenity === "post_office", 5, "bureau de poste", "post office"],
  [(t) => t.amenity === "pharmacy", 5, "pharmacie", "pharmacy"],
  [(t) => t.amenity === "police", 5, "police", "police"],
  [(t) => t.shop === "supermarket", 5, "supermarché", "supermarket"],
  [(t) => t.amenity === "school", 4, "école", "school"],
  [(t) => t.amenity === "library", 4, "bibliothèque", "library"],
  [(t) => t.amenity === "marketplace", 4, "marché", "market"],
  [(t) => t.amenity === "fuel", 4, "station-service", "fuel station"],
  [(t) => t.tourism === "hotel", 3, "hôtel", "hotel"],
  [(t) => t.tourism === "information", 3, "office de tourisme", "tourist info"],
];
const center = (g) => (g.type === "Point" ? g.coordinates : (() => { const b = bboxOf(g); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; })());

/** Repères utiles autour de p (8 au plus, catégories variées, plus proches d'abord à priorité égale). */
export async function landmarks(p, radius = 800, lang = "fr") {
  let data = null;
  // Overpass limite le débit (2 requêtes simultanées) : une seconde tentative après une pause.
  for (let i = 0; i < 2 && !data; i++) {
    try { data = await overpass(LANDMARK_QL(p[1].toFixed(6), p[0].toFixed(6), radius)); }
    catch { if (i === 0) await new Promise((r) => setTimeout(r, 2500)); }
  }
  if (!data) return [];
  const items = [];
  for (const f of data.features) {
    const t = f.properties || {};
    const k = KINDS.find(([test]) => test(t));
    if (!k) continue;
    const c = center(f.geometry);
    const d = distance(p, c);
    if (d < 15) continue; // le lieu lui-même
    const kind = typeof k[2] === "function" ? (lang === "en" ? k[3](t) : k[2](t)) : lang === "en" ? k[3] : k[2];
    items.push({ name: t.name || "", kind, coord: c, distance: d, bearing: bearing(p, c), score: k[1] - d / 400 + (t.name ? 1 : 0) });
  }
  items.sort((a, b) => b.score - a.score);
  // Diversité : au plus 2 repères d'un même genre.
  const per = {}, out = [];
  for (const it of items) {
    if ((per[it.kind] = (per[it.kind] || 0) + 1) > 2) continue;
    if (out.some((o) => o.name && o.name === it.name)) continue;
    out.push(it);
    if (out.length >= 8) break;
  }
  return out.sort((a, b) => a.distance - b.distance).map((it, i) => ({ ...it, n: i + 1, dir: cardinal(it.bearing, lang) }));
}

async function communeOf([lon, lat]) {
  try {
    const r = await fetch(`https://geo.api.gouv.fr/communes?lat=${lat}&lon=${lon}&fields=nom,codesPostaux,departement,region&format=json`);
    const c = (await r.json())[0];
    return c ? { nom: c.nom, cp: c.codesPostaux?.[0] || "", dep: c.departement?.nom || "", depCode: c.departement?.code || "", region: c.region?.nom || "" } : null;
  } catch { return null; }
}

// ---- Rédaction (IA, faits seulement) -------------------------------------------------
const SCHEMA = {
  type: "object",
  properties: {
    titre: { type: "string" },
    sous_titre: { type: "string" },
    acces: { type: "string" },
    reperes: { type: "array", items: { type: "string" } },
  },
  required: ["titre", "sous_titre", "acces", "reperes"],
};
function deterministicText(f, lang) {
  const en = lang === "en";
  const where = f.commune ? `${f.commune.nom}${f.commune.dep ? ` (${f.commune.dep})` : ""}` : "";
  const near = f.landmarks.slice(0, 3).map((l) => `${l.kind}${l.name ? ` ${l.name}` : ""} ${en ? "is" : "à"} ${fmtM(l.distance)} ${en ? "to the" : "au"} ${l.dir}`);
  const acces = [
    f.route ? (en ? `From ${f.route.from}: ${fmtM(f.route.distance)}, about ${fmtMin(f.route.duration)}.` : `Depuis ${f.route.from} : ${fmtM(f.route.distance)}, environ ${fmtMin(f.route.duration)}.`) : "",
    near.length ? (en ? `Nearby: ${near.join("; ")}.` : `À proximité : ${near.join(" ; ")}.`) : "",
  ].filter(Boolean).join(" ");
  return {
    titre: f.title || f.label.split(",")[0],
    sous_titre: where,
    acces: acces || (en ? "See map." : "Voir la carte."),
    reperes: f.landmarks.map((l) => `${l.kind}${l.name ? ` « ${l.name} »` : ""} — ${fmtM(l.distance)} ${en ? "to the" : "au"} ${l.dir}`),
  };
}
async function writeText(f, lang) {
  const facts = {
    lieu: f.label, titre_demande: f.title || null, commune: f.commune,
    coordonnees: `${f.coord[1].toFixed(5)}, ${f.coord[0].toFixed(5)}`,
    reperes: f.landmarks.map((l) => ({ n: l.n, genre: l.kind, nom: l.name || null, distance: fmtM(l.distance), direction: l.dir })),
    itineraire: f.route ? { depuis: f.route.from, mode: f.route.mode, distance: fmtM(f.route.distance), duree: fmtMin(f.route.duration), etapes_principales: f.route.steps.filter((s) => s.distance > 150).slice(0, 8).map((s) => `${s.text} (${fmtM(s.distance)})`) } : null,
  };
  const sys = lang === "en"
    ? "You write the text of a printed location map. Use ONLY the facts given (names, distances, directions); never invent a street, a line number, a time or a landmark. Reply in JSON: titre (short title), sous_titre (town, area), acces (how to get there, 2-4 sentences, ≤ 70 words), reperes (one short sentence per landmark, same order, starting with its number)."
    : "Tu rédiges le texte d'une carte de localisation imprimée. N'utilise QUE les faits fournis (noms, distances, directions) ; n'invente jamais une rue, un numéro de ligne, un horaire ou un repère. Réponds en JSON : titre (court), sous_titre (commune, secteur), acces (comment s'y rendre, 2 à 4 phrases, 70 mots au plus), reperes (une phrase courte par repère, même ordre, commençant par son numéro).";
  try {
    const r = await llmChat([{ role: "system", content: sys }, { role: "user", content: JSON.stringify(facts) }], { json: true, schema: SCHEMA, rawSystem: true, maxTokens: 700 });
    const t = String(r?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    if (!j.titre || !j.acces) throw new Error("incomplet");
    // Garde-fou : un chiffre de distance absent des faits = texte rejeté.
    const allowed = JSON.stringify(facts);
    const nums = `${j.acces} ${(j.reperes || []).join(" ")}`.match(/\d+(?:[.,]\d+)?\s?(?:km|m|min)\b/g) || [];
    if (nums.some((n) => !allowed.includes(n.replace(/\s/, " ")) && !allowed.includes(n.replace(/\s/, "")))) throw new Error("chiffre non sourcé");
    return { ...j, reperes: (j.reperes || []).slice(0, f.landmarks.length), ai: true };
  } catch { return { ...deterministicText(f, lang), ai: false }; }
}

// ---- Rendu des cartes ---------------------------------------------------------------
// « idle » peut arriver AVANT le chargement des tuiles de la nouvelle vue :
// on attend un rendu, puis que style et tuiles soient complets, puis un
// dernier rendu (le tampon contient alors l'image finale).
async function idle(map, ms = 20000) {
  const frame = () => new Promise((r) => { map.once("render", r); map.triggerRepaint(); setTimeout(r, 1000); });
  const end = Date.now() + ms;
  await frame();
  while (Date.now() < end && !(map.isStyleLoaded() && map.areTilesLoaded() && map.loaded())) await new Promise((r) => setTimeout(r, 150));
  await frame();
  await frame();
}
/** Canevas WebGL → JPEG sur fond blanc (la transparence deviendrait du noir). */
function canvasJpeg(cv) {
  const c = document.createElement("canvas");
  c.width = cv.width; c.height = cv.height;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(cv, 0, 0);
  return c.toDataURL("image/jpeg", 0.92);
}

/** Carte de situation (petite échelle) hors écran → { dataUrl, project }. */
async function overviewImage(styleUrl, c, zoom, frameBox) {
  const div = document.createElement("div");
  Object.assign(div.style, { position: "fixed", left: "-10000px", top: "0", width: "520px", height: "380px" });
  document.body.appendChild(div);
  const m = new maplibregl.Map({ container: div, style: styleUrl, center: c, zoom, interactive: false, attributionControl: false, preserveDrawingBuffer: true, fadeDuration: 0 });
  try {
    await new Promise((r) => { m.once("load", r); setTimeout(r, 15000); });
    await idle(m);
    const corners = frameBox.map((p) => m.project(p));
    return { dataUrl: canvasJpeg(m.getCanvas()), w: 520, h: 380, frame: corners.map((p) => [p.x, p.y]), center: (() => { const p = m.project(c); return [p.x, p.y]; })() };
  } finally { m.remove(); div.remove(); }
}

/** Échelle graphique : longueur « ronde » pour au plus `maxPx` pixels CSS. */
function scaleBar(map, maxPx) {
  const lat = map.getCenter().lat, z = map.getZoom();
  const mpp = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** z);
  const maxM = mpp * maxPx;
  const pow = 10 ** Math.floor(Math.log10(maxM));
  const nice = [5, 2, 1].map((k) => k * pow).find((v) => v <= maxM) || pow;
  return { meters: nice, px: nice / mpp, mpp };
}

// ---- PDF ------------------------------------------------------------------------------
/** Texte WinAnsi sûr (polices standard de pdf-lib). */
function safe(font, s) {
  const t = String(s ?? "").replace(/[’‘]/g, "'").replace(/[“”«»]/g, '"').replace(/[′]/g, "'").replace(/[″]/g, '"').replace(/[–—]/g, "-").replace(/→/g, "->").replace(/[  ]/g, " ");
  let out = "";
  for (const ch of t) { try { font.encodeText(ch); out += ch; } catch { out += "?"; } }
  return out;
}
function wrap(font, text, size, width) {
  const lines = [];
  for (const para of String(text).split("\n")) {
    let cur = "";
    for (const w of para.split(/\s+/)) {
      const cand = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(cand, size) <= width) cur = cand;
      else { if (cur) lines.push(cur); cur = w; }
    }
    lines.push(cur);
  }
  return lines;
}

/**
 * @param {object} ctx  API de Carte : map, basemap, layers, invoke, onStatus?
 * @param {{ lieu: string, depuis?: string, titre?: string, format?: "paysage"|"portrait", rayon?: number, mode?: "car"|"pedestrian"|"bike", lang?: string }} o
 */
export async function locationPdf(ctx, o) {
  const lang = o.lang || "fr", en = lang === "en";
  const status = (s) => ctx.onStatus?.(s);
  const map = ctx.map;

  status(en ? "Locating…" : "Localisation…");
  const hit = (await geocode(o.lieu))[0];
  if (!hit) throw new Error(en ? `Place not found: ${o.lieu}` : `Lieu introuvable : ${o.lieu}`);
  const coord = [hit.lon, hit.lat];

  status(en ? "Landmarks and town…" : "Repères et commune…");
  const radius = Math.max(200, Math.min(3000, Number(o.rayon) || 800));
  const [lms, commune] = await Promise.all([landmarks(coord, radius, lang), communeOf(coord)]);

  let rt = null;
  if (o.depuis) {
    status(en ? "Route…" : "Itinéraire…");
    const from = (await geocode(o.depuis))[0];
    if (from) {
      try { rt = { ...(await route([[from.lon, from.lat], coord], { mode: o.mode || "car", lang })), from: from.label.split(",")[0] }; } catch { rt = null; }
    }
  }
  const facts = { label: hit.label, title: o.titre || hit.label.split(",")[0], coord, commune, landmarks: lms, route: rt };

  status(en ? "Writing the access notes…" : "Rédaction des indications d'accès…");
  const text = await writeText(facts, lang);

  // ---- Carte principale : cadrage, capture -------------------------------------
  status(en ? "Rendering the map…" : "Rendu de la carte…");
  const saved = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  const tmp = "__pdf";
  const routeFeat = rt ? [{ type: "Feature", properties: {}, geometry: rt.geometry }] : [];
  let mainImg, project, bar, frameBox, frameCss;
  try {
    if (map.getSource(tmp)) { map.removeLayer(`${tmp}-line`); map.removeLayer(`${tmp}-casing`); map.removeSource(tmp); }
    map.addSource(tmp, { type: "geojson", data: fc(routeFeat) });
    map.addLayer({ id: `${tmp}-casing`, type: "line", source: tmp, paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.9 }, layout: { "line-cap": "round", "line-join": "round" } });
    map.addLayer({ id: `${tmp}-line`, type: "line", source: tmp, paint: { "line-color": "#2563eb", "line-width": 4 }, layout: { "line-cap": "round", "line-join": "round" } });
    // Emprise : le lieu et ses repères (l'itinéraire complet figure en texte ;
    // on ne dézoome pas toute une ville pour lui).
    const pts = [coord, ...lms.map((l) => l.coord)];
    const bb = bboxOf(fc(pts.map((p) => point(p))));
    const pad = Math.max(0.0015, (bb[2] - bb[0]) * 0.08);
    map.jumpTo({ bearing: 0, pitch: 0 });
    map.fitBounds([[bb[0] - pad, bb[1] - pad], [bb[2] + pad, bb[3] + pad]], { padding: 60, maxZoom: 17, duration: 0 });
    if (!lms.length) map.jumpTo({ center: coord, zoom: 16 });
    await idle(map);
    const cv = map.getCanvas();
    frameCss = [cv.clientWidth, cv.clientHeight];
    mainImg = canvasJpeg(cv);
    project = (p) => { const q = map.project(p); return [q.x, q.y]; };
    bar = scaleBar(map, frameCss[0] * 0.22);
    const b = map.getBounds();
    frameBox = [[b.getWest(), b.getNorth()], [b.getEast(), b.getNorth()], [b.getEast(), b.getSouth()], [b.getWest(), b.getSouth()]];
    var markers = { target: project(coord), lms: lms.map((l) => ({ n: l.n, xy: project(l.coord) })) };
    var edges = { w: b.getWest(), e: b.getEast(), n: b.getNorth(), s: b.getSouth() };
  } finally {
    if (map.getLayer(`${tmp}-line`)) map.removeLayer(`${tmp}-line`);
    if (map.getLayer(`${tmp}-casing`)) map.removeLayer(`${tmp}-casing`);
    if (map.getSource(tmp)) map.removeSource(tmp);
    map.jumpTo(saved);
  }

  status(en ? "Overview map…" : "Carte de situation…");
  let over = null;
  try { over = await overviewImage(BASEMAPS.plan.style, coord, 9.5, frameBox); } catch { over = null; }

  // ---- Mise en page --------------------------------------------------------------
  status(en ? "Building the PDF…" : "Composition du PDF…");
  const PL = await import("../lib/vendor/pdf-lib.js");
  const doc = await PL.PDFDocument.create();
  const F = await doc.embedFont(PL.StandardFonts.Helvetica), FB = await doc.embedFont(PL.StandardFonts.HelveticaBold);
  const portrait = o.format === "portrait";
  const [PW, PH] = portrait ? [595.28, 841.89] : [841.89, 595.28];
  const page = doc.addPage([PW, PH]);
  const M = 24, INK = PL.rgb(0.1, 0.1, 0.12), GREY = PL.rgb(0.42, 0.42, 0.46), ACC = PL.rgb(1, 0.216, 0.373), BLUE = PL.rgb(0.145, 0.388, 0.922), LINE = PL.rgb(0.85, 0.85, 0.87);
  const T = (s, x, y, size = 9, font = F, color = INK) => page.drawText(safe(font, s), { x, y, size, font, color });
  const top = PH - M;

  // En-tête
  T(text.titre, M, top - 18, 18, FB);
  T(text.sous_titre || (commune ? `${commune.nom} (${commune.depCode})` : ""), M, top - 33, 10, F, GREY);
  const dateStr = new Date().toLocaleDateString(en ? "en-GB" : "fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const dw = F.widthOfTextAtSize(safe(F, dateStr), 9);
  T(dateStr, PW - M - dw, top - 16, 9, F, GREY);
  page.drawLine({ start: { x: M, y: top - 42 }, end: { x: PW - M, y: top - 42 }, thickness: 0.6, color: LINE });

  // Zone carte
  const headerH = 50, footerH = 30;
  const colW = portrait ? 0 : 230;
  const boxX = M, boxTop = top - headerH, boxW = PW - 2 * M - (colW ? colW + 16 : 0);
  const boxH = portrait ? (PH - 2 * M - headerH) * 0.55 : PH - 2 * M - headerH - footerH;
  const k = Math.min(boxW / frameCss[0], boxH / frameCss[1]);
  const iw = frameCss[0] * k, ih = frameCss[1] * k;
  const ix = boxX + (boxW - iw) / 2, iy = boxTop - ih;
  const img = await doc.embedJpg(mainImg);
  page.drawImage(img, { x: ix, y: iy, width: iw, height: ih });
  page.drawRectangle({ x: ix, y: iy, width: iw, height: ih, borderColor: INK, borderWidth: 0.8 });
  const toPdf = ([x, y]) => [ix + x * k, iy + ih - y * k];
  const inside = ([x, y]) => x >= ix && x <= ix + iw && y >= iy && y <= iy + ih;

  // Repères numérotés puis le lieu (au-dessus)
  for (const m of markers.lms) {
    const [x, y] = toPdf(m.xy);
    if (!inside([x, y])) continue;
    page.drawCircle({ x, y, size: 7, color: PL.rgb(0.13, 0.13, 0.15), borderColor: PL.rgb(1, 1, 1), borderWidth: 1.2 });
    const s = String(m.n), w = FB.widthOfTextAtSize(s, 7.5);
    page.drawText(s, { x: x - w / 2, y: y - 2.7, size: 7.5, font: FB, color: PL.rgb(1, 1, 1) });
  }
  {
    const [x, y] = toPdf(markers.target);
    page.drawCircle({ x, y, size: 16, color: ACC, opacity: 0.18 });
    page.drawCircle({ x, y, size: 7.5, color: ACC, borderColor: PL.rgb(1, 1, 1), borderWidth: 2 });
  }

  // Flèche du nord (carte orientée nord en haut)
  {
    const cx = ix + iw - 22, cy = iy + ih - 30;
    page.drawRectangle({ x: cx - 14, y: cy - 18, width: 28, height: 40, color: PL.rgb(1, 1, 1), opacity: 0.85 });
    page.drawSvgPath("M 0 -14 L 7 8 L 0 3 L -7 8 Z", { x: cx, y: cy, color: INK, scale: 1 });
    T("N", cx - 3.5, cy + 9, 9, FB);
  }
  // Échelle graphique
  {
    const lenPt = bar.px * k, x0 = ix + 12, y0 = iy + 14;
    const lab = fmtM(bar.meters);
    page.drawRectangle({ x: x0 - 6, y: y0 - 7, width: lenPt + 12 + FB.widthOfTextAtSize(safe(FB, lab), 8) + 8, height: 20, color: PL.rgb(1, 1, 1), opacity: 0.85 });
    page.drawRectangle({ x: x0, y: y0, width: lenPt / 2, height: 4, color: INK });
    page.drawRectangle({ x: x0 + lenPt / 2, y: y0, width: lenPt / 2, height: 4, color: PL.rgb(1, 1, 1), borderColor: INK, borderWidth: 0.6 });
    T("0", x0 - 2, y0 + 6, 6.5, F, GREY);
    T(lab, x0 + lenPt + 6, y0 - 1, 8, FB);
    const ratio = Math.round((bar.mpp / k) * 72 / 0.0254 / 100) * 100;
    T(`1:${ratio.toLocaleString("fr-FR").replace(/ /g, " ")}`, x0 + lenPt + 6, y0 + 8, 6.5, F, GREY);
  }
  // Coordonnées des bords (graticule simplifié)
  T(`${edges.n.toFixed(4)}°`, ix + 3, iy + ih + 3, 6.5, F, GREY);
  T(`${edges.s.toFixed(4)}°`, ix + 3, iy - 8, 6.5, F, GREY);
  { const s = `${edges.e.toFixed(4)}°`; T(s, ix + iw - F.widthOfTextAtSize(s, 6.5), iy - 8, 6.5, F, GREY); }
  { const s = `${edges.w.toFixed(4)}°`; T(s, ix + iw / 2 - F.widthOfTextAtSize(s, 6.5) / 2, iy - 8, 6.5, F, GREY); }

  // Colonne d'informations
  let cx, cy, cw, bottom;
  if (portrait) { cx = M; cy = iy - 22; cw = PW - 2 * M; bottom = M + footerH; }
  else { cx = PW - M - colW; cy = boxTop; cw = colW; bottom = M + footerH; }
  const H = (s) => { if (cy - 12 < bottom) return false; T(s.toUpperCase(), cx, cy - 9, 7.5, FB, GREY); cy -= 15; return true; };
  const P = (s, size = 8.5, font = F, color = INK, indent = 0) => {
    for (const line of wrap(font, safe(font, s), size, cw - indent)) { if (cy - size < bottom) { T("…", cx + indent, cy - size, size, font, GREY); cy = bottom - 1; return false; } T(line, cx + indent, cy - size, size, font, color); cy -= size + 2.6; }
    return true;
  };

  if (portrait) {
    // Deux colonnes sous la carte : situation + coordonnées | accès, repères, itinéraire
    const half = (cw - 16) / 2;
    const left = { x: cx, w: half }, right = { x: cx + half + 16, w: half };
    let ly = cy;
    if (over) {
      const ow = left.w, oh = (over.h / over.w) * ow;
      page.drawImage(await doc.embedJpg(over.dataUrl), { x: left.x, y: ly - oh, width: ow, height: oh });
      drawOverviewFrame(page, PL, over, left.x, ly - oh, ow / over.w, oh, ACC);
      page.drawRectangle({ x: left.x, y: ly - oh, width: ow, height: oh, borderColor: INK, borderWidth: 0.6 });
      ly -= oh + 12;
    }
    const sv = { cx, cw, cy };
    cx = left.x; cw = left.w; cy = ly;
    coordsBlock();
    cx = right.x; cw = right.w; cy = sv.cy;
  } else {
    if (over) {
      const ow = cw, oh = (over.h / over.w) * ow;
      H(en ? "Situation" : "Situation");
      page.drawImage(await doc.embedJpg(over.dataUrl), { x: cx, y: cy - oh, width: ow, height: oh });
      drawOverviewFrame(page, PL, over, cx, cy - oh, ow / over.w, oh, ACC);
      page.drawRectangle({ x: cx, y: cy - oh, width: ow, height: oh, borderColor: INK, borderWidth: 0.6 });
      cy -= oh + 10;
    }
    coordsBlock();
  }

  function coordsBlock() {
    H(en ? "Coordinates (WGS84)" : "Coordonnées (WGS84)");
    P(`${coord[1].toFixed(5)}, ${coord[0].toFixed(5)}`, 9, FB);
    P(`${dms(coord[1], true)}  ${dms(coord[0], false)}`, 8, F, GREY);
    P(hit.label, 8, F, GREY);
    cy -= 6;
  }

  H(en ? "Access" : "Accès");
  P(text.acces);
  cy -= 6;
  if (lms.length && H(en ? "Landmarks" : "Repères")) {
    lms.forEach((l, i) => {
      const s = (text.reperes?.[i] || `${l.kind}${l.name ? ` « ${l.name} »` : ""} — ${fmtM(l.distance)} ${en ? "to the" : "au"} ${l.dir}`).replace(/^\s*\d+[.)\-:]?\s*/, "");
      if (cy - 9 < bottom) return;
      page.drawCircle({ x: cx + 5, y: cy - 6, size: 5, color: PL.rgb(0.13, 0.13, 0.15) });
      const n = String(l.n); page.drawText(n, { x: cx + 5 - FB.widthOfTextAtSize(n, 6) / 2, y: cy - 8.1, size: 6, font: FB, color: PL.rgb(1, 1, 1) });
      P(s, 8, F, INK, 14);
      cy -= 1.5;
    });
    cy -= 5;
  }
  if (rt && H(`${en ? "Route from" : "Itinéraire depuis"} ${rt.from}`)) {
    P(`${fmtM(rt.distance)} · ${fmtMin(rt.duration)}${rt.estimated ? (en ? " (bike, est.)" : " (vélo, estimé)") : rt.mode === "pedestrian" ? (en ? " on foot" : " à pied") : (en ? " by car" : " en voiture")}`, 8.5, FB, BLUE);
    const steps = rt.steps.filter((s, i) => s.distance > 40 || i === rt.steps.length - 1);
    for (const [i, s] of steps.entries()) if (!P(`${i + 1}. ${s.text}${s.distance > 1 ? ` — ${fmtM(s.distance)}` : ""}`, 7.5, F, INK)) break;
  }

  // Pied de page : crédits
  const credits = [...new Set([
    ...[...document.querySelectorAll(".maplibregl-ctrl-attrib-inner")].map((n) => n.textContent.trim()).filter(Boolean),
    lms.length ? `${OSM_CREDIT.source} (${OSM_CREDIT.license})` : "",
    rt ? `${IGN_CREDIT.source} (${IGN_CREDIT.license})` : "",
    commune ? "geo.api.gouv.fr (Licence Ouverte 2.0)" : "",
    hit.credit ? `${hit.credit.source} (${hit.credit.license})` : "",
  ].filter(Boolean))].join(" · ");
  page.drawLine({ start: { x: M, y: M + 18 }, end: { x: PW - M, y: M + 18 }, thickness: 0.5, color: LINE });
  const credLines = wrap(F, safe(F, `${en ? "Sources" : "Sources"} : ${credits}`), 6.5, PW - 2 * M - 160);
  credLines.slice(0, 2).forEach((l, i) => T(l, M, M + 9 - i * 8, 6.5, F, GREY));
  const gen = en ? `Generated by Lumen${text.ai ? " (text written by AI from computed data)" : ""}` : `Généré par Lumen${text.ai ? " (texte rédigé par l'IA à partir des données calculées)" : ""}`;
  const gw = F.widthOfTextAtSize(safe(F, gen), 6.5);
  T(gen, PW - M - Math.min(gw, 160), M + 9, 6.5, F, GREY);

  doc.setTitle(safe(F, text.titre));
  doc.setCreator("Lumen — Carte");
  const bytes = await doc.save();
  return { bytes, title: text.titre, landmarks: lms.length, route: rt ? `${fmtM(rt.distance)}, ${fmtMin(rt.duration)}` : null, ai: text.ai };
}

function drawOverviewFrame(page, PL, over, x, y, k, h, color) {
  const pts = over.frame.map(([px, py]) => [x + px * k, y + h - py * k]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  let w = Math.max(...xs) - Math.min(...xs), hh = Math.max(...ys) - Math.min(...ys);
  const cx = x + over.center[0] * k, cy = y + h - over.center[1] * k;
  // Cadre trop petit pour être visible : un repère circulaire à la place.
  if (w < 6 || hh < 6) { page.drawCircle({ x: cx, y: cy, size: 5, borderColor: color, borderWidth: 1.6 }); return; }
  page.drawRectangle({ x: Math.min(...xs), y: Math.min(...ys), width: w, height: hh, borderColor: color, borderWidth: 1.4 });
}
