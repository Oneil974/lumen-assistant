// Géotraitements de Carte : l'essentiel de Turf.js, sans dépendance.
//
// Tout est en WGS84 (lon, lat), entrées/sorties GeoJSON, distances en MÈTRES.
// Les calculs « plans » (enveloppe, grilles, découpe, simplification) se font
// dans une projection équirectangulaire locale centrée sur les données : à
// l'échelle d'une ville ou d'un département l'erreur reste sous le pour cent,
// ce qui suffit pour de l'analyse courante (Turf fait des approximations
// comparables pour buffer/simplify).

export const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export const fc = (features) => ({ type: "FeatureCollection", features });
export const feature = (geometry, properties = {}) => ({ type: "Feature", properties, geometry });
export const point = (c, p = {}) => feature({ type: "Point", coordinates: c }, p);
export const label = (f) => f?.properties?.name || f?.properties?.nom || f?.properties?.label || f?.properties?.titre || null;

// ---- Mesures --------------------------------------------------------------------
/** Distance orthodromique (m). */
export function distance([lon1, lat1], [lon2, lat2]) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
/** Cap initial de a vers b, en degrés (0 = nord, sens horaire). */
export function bearing([lon1, lat1], [lon2, lat2]) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
/** Point atteint depuis p en parcourant `m` mètres au cap `b`. */
export function destination([lon, lat], m, b) {
  const d = m / R, t = rad(b), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [((deg(l2) + 540) % 360) - 180, deg(p2)];
}
export const midpoint = (a, b) => destination(a, distance(a, b) / 2, bearing(a, b));

const CARD_FR = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
const CARD_EN = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
/** Cap → point cardinal en clair (8 secteurs). */
export const cardinal = (b, lang = "fr") => (lang === "en" ? CARD_EN : CARD_FR)[Math.round(((b % 360) + 360) % 360 / 45) % 8];

function lineLen(c) { let s = 0; for (let i = 1; i < c.length; i++) s += distance(c[i - 1], c[i]); return s; }
/** Longueur (m) : lignes, et périmètre des polygones. */
export function length(g) {
  if (!g) return 0;
  switch (g.type) {
    case "LineString": return lineLen(g.coordinates);
    case "MultiLineString": case "Polygon": return g.coordinates.reduce((s, c) => s + lineLen(c), 0);
    case "MultiPolygon": return g.coordinates.reduce((s, p) => s + p.reduce((t, c) => t + lineLen(c), 0), 0);
    case "GeometryCollection": return g.geometries.reduce((s, x) => s + length(x), 0);
    default: return 0;
  }
}
function ringArea(c) {
  let s = 0;
  for (let i = 0; i < c.length - 1; i++) s += rad(c[i + 1][0] - c[i][0]) * (2 + Math.sin(rad(c[i][1])) + Math.sin(rad(c[i + 1][1])));
  return Math.abs((s * R * R) / 2);
}
/** Superficie (m²) sur la sphère. */
export function area(g) {
  if (!g) return 0;
  if (g.type === "Polygon") return ringArea(g.coordinates[0]) - g.coordinates.slice(1).reduce((t, h) => t + ringArea(h), 0);
  if (g.type === "MultiPolygon") return g.coordinates.reduce((t, p) => t + area({ type: "Polygon", coordinates: p }), 0);
  if (g.type === "GeometryCollection") return g.geometries.reduce((s, x) => s + area(x), 0);
  return 0;
}

// ---- Parcours des coordonnées ----------------------------------------------------
export function coordsOf(g, out = []) {
  if (!g) return out;
  if (g.type === "GeometryCollection") { g.geometries.forEach((x) => coordsOf(x, out)); return out; }
  const visit = (c) => { if (typeof c[0] === "number") out.push(c); else c.forEach(visit); };
  visit(g.coordinates);
  return out;
}
const geomsOf = (x) => (x?.type === "FeatureCollection" ? x.features.map((f) => f.geometry) : x?.type === "Feature" ? [x.geometry] : [x]).filter(Boolean);

/** Emprise [w, s, e, n] d'une géométrie, d'un objet ou d'une collection. */
export function bbox(x) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const g of geomsOf(x)) for (const [lo, la] of coordsOf(g)) { if (lo < w) w = lo; if (lo > e) e = lo; if (la < s) s = la; if (la > n) n = la; }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}
export const bboxPolygon = ([w, s, e, n]) => ({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

/** Centroïde (moyenne des sommets ; barycentre surfacique pour un polygone simple). */
export function centroid(g) {
  if (!g) return null;
  if (g.type === "Point") return g.coordinates;
  if (g.type === "Polygon") {
    const c = g.coordinates[0];
    let a = 0, x = 0, y = 0;
    for (let i = 0; i < c.length - 1; i++) {
      const f = c[i][0] * c[i + 1][1] - c[i + 1][0] * c[i][1];
      a += f; x += (c[i][0] + c[i + 1][0]) * f; y += (c[i][1] + c[i + 1][1]) * f;
    }
    if (Math.abs(a) > 1e-12) return [x / (3 * a), y / (3 * a)];
  }
  const pts = coordsOf(g);
  if (!pts.length) return null;
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}
/** Centre moyen d'un ensemble d'objets (éventuellement pondéré par un attribut). */
export function centerMean(features, weightKey) {
  let sx = 0, sy = 0, sw = 0;
  for (const f of features) {
    const c = centroid(f.geometry); if (!c) continue;
    const w = weightKey ? Number(f.properties?.[weightKey]) || 0 : 1;
    sx += c[0] * w; sy += c[1] * w; sw += w;
  }
  return sw ? [sx / sw, sy / sw] : null;
}

// ---- Projection locale (calculs plans) -----------------------------------------
/** Projection équirectangulaire locale → { fwd([lon,lat]) → [x,y] m, inv }. */
export function localProj(ref) {
  const [lon0, lat0] = ref;
  const k = Math.cos(rad(lat0));
  return {
    fwd: ([lon, lat]) => [rad(lon - lon0) * R * k, rad(lat - lat0) * R],
    inv: ([x, y]) => [lon0 + deg(x / (R * k)), lat0 + deg(y / R)],
  };
}

// ---- Prédicats -------------------------------------------------------------------
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Le point est-il dans le polygone (trous gérés) ? */
export function pointInPolygon(p, g) {
  if (!g) return false;
  if (g.type === "Polygon") return inRing(p, g.coordinates[0]) && !g.coordinates.slice(1).some((h) => inRing(p, h));
  if (g.type === "MultiPolygon") return g.coordinates.some((poly) => pointInPolygon(p, { type: "Polygon", coordinates: poly }));
  return false;
}
const isPoly = (g) => g && (g.type === "Polygon" || g.type === "MultiPolygon");

// ---- Lignes -----------------------------------------------------------------------
const linesOf = (g) => (g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" || g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : []);

/** Point situé à `m` mètres le long d'une ligne. */
export function along(g, m) {
  const c = linesOf(g)[0] || [];
  let acc = 0;
  for (let i = 1; i < c.length; i++) {
    const d = distance(c[i - 1], c[i]);
    if (acc + d >= m) return destination(c[i - 1], m - acc, bearing(c[i - 1], c[i]));
    acc += d;
  }
  return c.at(-1) || null;
}
/** Point de la géométrie le plus proche de p → { point, distance }. */
export function nearestPointOn(g, p) {
  if (g.type === "Point") return { point: g.coordinates, distance: distance(p, g.coordinates) };
  const pr = localProj(p);
  const P = [0, 0];
  let best = null;
  const consider = (q) => { const d = distance(p, q); if (!best || d < best.distance) best = { point: q, distance: d }; };
  for (const line of linesOf(g)) {
    for (let i = 1; i < line.length; i++) {
      const A = pr.fwd(line[i - 1]), B = pr.fwd(line[i]);
      const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2)) : 0;
      consider(pr.inv([A[0] + t * dx, A[1] + t * dy]));
    }
  }
  if (g.type === "MultiPoint") g.coordinates.forEach(consider);
  if (isPoly(g) && pointInPolygon(p, g)) return { point: p, distance: 0 };
  return best;
}
/** Points d'intersection entre deux géométries linéaires (ou contours). */
export function lineIntersect(g1, g2) {
  const out = [];
  const segs = (g) => linesOf(g).flatMap((c) => c.slice(1).map((p, i) => [c[i], p]));
  const s2 = segs(g2);
  for (const [a, b] of segs(g1)) for (const [c, d] of s2) {
    const den = (d[1] - c[1]) * (b[0] - a[0]) - (d[0] - c[0]) * (b[1] - a[1]);
    if (!den) continue;
    const ua = ((d[0] - c[0]) * (a[1] - c[1]) - (d[1] - c[1]) * (a[0] - c[0])) / den;
    const ub = ((b[0] - a[0]) * (a[1] - c[1]) - (b[1] - a[1]) * (a[0] - c[0])) / den;
    if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) out.push([a[0] + ua * (b[0] - a[0]), a[1] + ua * (b[1] - a[1])]);
  }
  return out;
}
/** Arc de grand cercle entre deux points (pour tracer une liaison « à vol d'oiseau »). */
export function greatCircle(a, b, steps = 64) {
  const d = distance(a, b);
  if (d < 50000) return { type: "LineString", coordinates: [a, b] };
  const c = [a];
  for (let i = 1; i < steps; i++) c.push(destination(c[i - 1], d / steps, bearing(c[i - 1], b)));
  c.push(b);
  return { type: "LineString", coordinates: c };
}

// ---- Simplification (Douglas-Peucker, tolérance en mètres) ------------------------
function dp(pts, tol) {
  if (pts.length < 3) return pts;
  const [A, B] = [pts[0], pts.at(-1)];
  const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1;
  let idx = 0, max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + B[0] * A[1] - B[1] * A[0]) / L;
    if (d > max) { max = d; idx = i; }
  }
  return max > tol ? [...dp(pts.slice(0, idx + 1), tol).slice(0, -1), ...dp(pts.slice(idx), tol)] : [A, B];
}
export function simplify(g, tolM) {
  const c0 = centroid(g); if (!c0) return g;
  const pr = localProj(c0);
  const s = (line, ring) => {
    const out = dp(line.map(pr.fwd), tolM).map(pr.inv);
    return ring && out.length < 4 ? line : out;
  };
  switch (g.type) {
    case "LineString": return { ...g, coordinates: s(g.coordinates) };
    case "MultiLineString": return { ...g, coordinates: g.coordinates.map((l) => s(l)) };
    case "Polygon": return { ...g, coordinates: g.coordinates.map((r) => s(r, true)) };
    case "MultiPolygon": return { ...g, coordinates: g.coordinates.map((p) => p.map((r) => s(r, true))) };
    default: return g;
  }
}

// ---- Enveloppes -------------------------------------------------------------------
/** Enveloppe convexe (chaîne monotone d'Andrew) d'un ensemble de points [lon,lat]. */
export function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return null;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
  const ring = [...lo.slice(0, -1), ...up.slice(0, -1)];
  return ring.length >= 3 ? { type: "Polygon", coordinates: [[...ring, ring[0]]] } : null;
}

export function circle(c, m, steps = 64) {
  const ring = [];
  for (let i = 0; i < steps; i++) ring.push(destination(c, m, (i * 360) / steps));
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

/**
 * Zone tampon de `m` mètres. Point → cercle ; ligne → « capsules » par segment
 * (union approximative en MultiPolygon) ; polygone → polygone élargi par les
 * capsules de son contour + le polygone lui-même. Rapide et lisible ; pour une
 * surface exacte de l'union, préférer des tampons de points.
 */
export function buffer(g, m, steps = 24) {
  if (!g) return null;
  if (g.type === "Point") return circle(g.coordinates, m, steps * 2);
  if (g.type === "MultiPoint") return { type: "MultiPolygon", coordinates: g.coordinates.map((c) => circle(c, m, steps * 2).coordinates) };
  const polys = [];
  for (const line of linesOf(g)) {
    if (line.length === 1) { polys.push(circle(line[0], m, steps).coordinates); continue; }
    for (let i = 1; i < line.length; i++) {
      const h = convexHull([...circle(line[i - 1], m, steps).coordinates[0], ...circle(line[i], m, steps).coordinates[0]]);
      if (h) polys.push(h.coordinates);
    }
  }
  if (g.type === "Polygon") polys.push(g.coordinates);
  if (g.type === "MultiPolygon") polys.push(...g.coordinates);
  return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
}

// ---- Découpe (Sutherland-Hodgman : la zone de découpe doit être convexe) ----------
function clipRing(subject, clip) {
  // clip : anneau convexe, sens indifférent (on l'oriente).
  let c = clip.slice(0, -1);
  const signed = c.reduce((s, p, i) => s + (c[(i + 1) % c.length][0] - p[0]) * (c[(i + 1) % c.length][1] + p[1]), 0);
  if (signed > 0) c = c.reverse(); // sens trigonométrique
  const inside = (p, a, b) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
  const inter = (p, q, a, b) => {
    const A1 = q[1] - p[1], B1 = p[0] - q[0], C1 = A1 * p[0] + B1 * p[1];
    const A2 = b[1] - a[1], B2 = a[0] - b[0], C2 = A2 * a[0] + B2 * a[1];
    const det = A1 * B2 - A2 * B1;
    return det ? [(B2 * C1 - B1 * C2) / det, (A1 * C2 - A2 * C1) / det] : p;
  };
  let out = subject.slice(0, -1);
  for (let i = 0; i < c.length && out.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length], input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const P = input[j], Q = input[(j + 1) % input.length];
      if (inside(Q, a, b)) { if (!inside(P, a, b)) out.push(inter(P, Q, a, b)); out.push(Q); }
      else if (inside(P, a, b)) out.push(inter(P, Q, a, b));
    }
  }
  return out.length >= 3 ? [...out, out[0]] : null;
}
function clipLine(line, clipPoly) {
  // Garde les portions de ligne dont le milieu de segment est dans la zone.
  const parts = []; let cur = [];
  for (let i = 1; i < line.length; i++) {
    const mid = [(line[i - 1][0] + line[i][0]) / 2, (line[i - 1][1] + line[i][1]) / 2];
    if (pointInPolygon(mid, clipPoly)) { if (!cur.length) cur.push(line[i - 1]); cur.push(line[i]); }
    else if (cur.length) { parts.push(cur); cur = []; }
  }
  if (cur.length) parts.push(cur);
  return parts;
}
/** Découpe une géométrie par une zone (polygone convexe exact ; concave : approximation par enveloppe pour les surfaces). */
export function clip(g, zone) {
  const zr = zone.type === "Polygon" ? zone : convexHull(coordsOf(zone));
  if (!zr) return null;
  if (g.type === "Point") return pointInPolygon(g.coordinates, zone) ? g : null;
  if (g.type === "MultiPoint") { const c = g.coordinates.filter((p) => pointInPolygon(p, zone)); return c.length ? { type: "MultiPoint", coordinates: c } : null; }
  if (g.type === "LineString" || g.type === "MultiLineString") {
    const parts = linesOf(g).flatMap((l) => clipLine(l, zone));
    return !parts.length ? null : parts.length === 1 ? { type: "LineString", coordinates: parts[0] } : { type: "MultiLineString", coordinates: parts };
  }
  const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates).map((p) => clipRing(p[0], zr.coordinates[0])).filter(Boolean);
  return !polys.length ? null : polys.length === 1 ? { type: "Polygon", coordinates: [polys[0]] } : { type: "MultiPolygon", coordinates: polys.map((r) => [r]) };
}

// ---- Grilles ----------------------------------------------------------------------
/** Grille carrée ou hexagonale couvrant l'emprise, cellules de `size` mètres. */
export function grid(bb, size, kind = "hex", max = 5000) {
  const [w, s, e, n] = bb;
  const pr = localProj([(w + e) / 2, (s + n) / 2]);
  const [x0, y0] = pr.fwd([w, s]), [x1, y1] = pr.fwd([e, n]);
  const cells = [];
  if (kind === "square") {
    for (let x = x0; x < x1; x += size) for (let y = y0; y < y1; y += size) {
      cells.push([[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]);
      if (cells.length > max) throw new Error(`Grille trop fine (> ${max} cellules) : augmentez la taille.`);
    }
  } else {
    const r = size / Math.sqrt(3); // size = distance entre centres
    const dx = size, dy = 1.5 * r;
    let row = 0;
    for (let y = y0; y < y1 + dy; y += dy, row++) for (let x = x0 + (row % 2 ? dx / 2 : 0); x < x1 + dx; x += dx) {
      const ring = [];
      for (let i = 0; i < 6; i++) { const a = rad(60 * i + 30); ring.push([x + r * Math.cos(a), y + r * Math.sin(a)]); }
      ring.push(ring[0]);
      cells.push(ring);
      if (cells.length > max) throw new Error(`Grille trop fine (> ${max} cellules) : augmentez la taille.`);
    }
  }
  return cells.map((ring) => ({ type: "Polygon", coordinates: [ring.map(pr.inv)] }));
}

// ---- Regroupements ---------------------------------------------------------------
/** k-moyennes sur les centroïdes → index de groupe par objet. */
export function kmeans(points, k, iters = 40) {
  if (!points.length) return [];
  k = Math.max(1, Math.min(k, points.length));
  const pr = localProj(points[0]);
  const P = points.map(pr.fwd);
  // Initialisation k-means++ déterministe (point le plus éloigné).
  const C = [P[0]];
  while (C.length < k) {
    let bi = 0, bd = -1;
    P.forEach((p, i) => { const d = Math.min(...C.map((c) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2)); if (d > bd) { bd = d; bi = i; } });
    C.push(P[bi]);
  }
  let assign = new Array(P.length).fill(0);
  for (let it = 0; it < iters; it++) {
    const next = P.map((p) => { let bi = 0, bd = Infinity; C.forEach((c, i) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; });
    const moved = next.some((v, i) => v !== assign[i]);
    assign = next;
    for (let i = 0; i < k; i++) {
      const mine = P.filter((_, j) => assign[j] === i);
      if (mine.length) C[i] = [mine.reduce((s, p) => s + p[0], 0) / mine.length, mine.reduce((s, p) => s + p[1], 0) / mine.length];
    }
    if (!moved && it) break;
  }
  return assign;
}
/** DBSCAN : groupes de points distants de moins de `eps` m (≥ minPts) ; -1 = isolé. */
export function dbscan(points, eps, minPts = 3) {
  const n = points.length, lab = new Array(n).fill(undefined);
  const pr = localProj(points[0] || [0, 0]);
  const P = points.map(pr.fwd);
  const nb = (i) => { const out = []; for (let j = 0; j < n; j++) if ((P[i][0] - P[j][0]) ** 2 + (P[i][1] - P[j][1]) ** 2 <= eps * eps) out.push(j); return out; };
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (lab[i] !== undefined) continue;
    const N = nb(i);
    if (N.length < minPts) { lab[i] = -1; continue; }
    lab[i] = c;
    const queue = N.filter((j) => j !== i);
    while (queue.length) {
      const j = queue.shift();
      if (lab[j] === -1) lab[j] = c;
      if (lab[j] !== undefined) continue;
      lab[j] = c;
      const M = nb(j);
      if (M.length >= minPts) queue.push(...M);
    }
    c++;
  }
  return lab;
}

// ---- Tournée (voyageur de commerce approché) ---------------------------------------
/** Ordre de visite court : plus proche voisin puis 2-opt. Le premier point reste le départ ; `loop` = retour au départ. */
export function optimizeOrder(pts, { loop = false, keepLast = false } = {}) {
  const n = pts.length;
  if (n < 4) return pts.map((_, i) => i);
  const D = pts.map((a) => pts.map((b) => distance(a, b)));
  const order = [0], left = new Set(pts.map((_, i) => i).slice(1));
  if (keepLast) left.delete(n - 1);
  while (left.size) {
    const last = order.at(-1);
    let bi = -1, bd = Infinity;
    for (const j of left) if (D[last][j] < bd) { bd = D[last][j]; bi = j; }
    order.push(bi); left.delete(bi);
  }
  if (keepLast) order.push(n - 1);
  const total = (o) => o.slice(1).reduce((s, v, i) => s + D[o[i]][v], 0) + (loop ? D[o.at(-1)][o[0]] : 0);
  let best = total(order), improved = true;
  const end = keepLast ? n - 1 : n;
  while (improved) {
    improved = false;
    for (let i = 1; i < end - 1; i++) for (let k = i + 1; k < end; k++) {
      const cand = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
      const t = total(cand);
      if (t + 1e-6 < best) { order.splice(0, n, ...cand); best = t; improved = true; }
    }
  }
  return order;
}

// ---- Interpolation (pondération inverse à la distance) ------------------------------
/** Valeur IDW au point p à partir de points porteurs d'une valeur numérique. */
export function idw(p, samples, power = 2) {
  let num = 0, den = 0;
  for (const [c, v] of samples) {
    const d = distance(p, c);
    if (d < 1) return v;
    const w = 1 / d ** power;
    num += w * v; den += w;
  }
  return den ? num / den : null;
}

// ---- Formats -----------------------------------------------------------------------
export const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1).replace(".", ",")} km` : `${Math.round(m)} m`);
export const fmtA = (a) => (a >= 1e6 ? `${(a / 1e6).toFixed(2).replace(".", ",")} km²` : a >= 1e4 ? `${(a / 1e4).toFixed(2).replace(".", ",")} ha` : `${Math.round(a)} m²`);
export const fmtMin = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, "0")}` : `${Math.round(min)} min`);
/** 45.7640 → 45°45′50,4″ N */
export function dms(v, isLat) {
  const h = isLat ? (v >= 0 ? "N" : "S") : v >= 0 ? "E" : "O";
  const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60;
  return `${d}°${String(m).padStart(2, "0")}′${s.toFixed(1).replace(".", ",").padStart(4, "0")}″ ${h}`;
}
