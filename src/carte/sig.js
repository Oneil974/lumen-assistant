// Onglet « SIG » de Carte : mesures interactives, itinéraires, géotraitements
// (façon Turf.js, en formulaires) et carte de localisation PDF.
//
// Les OPÉRATIONS sont décrites une seule fois (OPS) et servent à la fois au
// formulaire de l'onglet et aux outils de l'assistant (catégorie « sig »).

import * as G from "./geo.js";
import { route, isoline, matrix, routeSummary, IGN_CREDIT } from "./route.js";
import { geocode } from "./sources.js";
import { locationPdf } from "./pdf-map.js";
import { tt } from "../apps-i18n.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SELF = { source: "Calcul Lumen (géotraitement)", license: "dérivé des couches sources", url: "" };
const derived = (l) => (l?.credit ? { ...l.credit, source: `${l.credit.source} — traité par Lumen` } : SELF);

// ---- Lieux : nom, adresse ou « lat, lon » ------------------------------------------
export async function resolvePlace(s, ctx) {
  const t = String(s ?? "").trim();
  if (!t) { const c = ctx.map.getCenter(); return { coord: [c.lng, c.lat], label: tt("centre de la vue") }; }
  const m = t.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    // Convention « lat, lon » (celle des GPS et des cartes en ligne) ; inversée si impossible.
    const [lat, lon] = Math.abs(a) <= 90 ? [a, b] : [b, a];
    return { coord: [lon, lat], label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
  }
  const h = (await geocode(t))[0];
  if (!h) throw new Error(tt("Lieu introuvable : {q}", { q: t }));
  return { coord: [h.lon, h.lat], label: h.label.split(",").slice(0, 2).join(",") };
}

// ---- Opérations ------------------------------------------------------------------
// champ : { k, type: "layer"|"num"|"text"|"select"|"bool", label, def?, opts?, opt? }
const pts = (l) => l.data.features.map((f) => [f, G.centroid(f.geometry)]).filter(([, c]) => c);
export const OPS = [
  { id: "tampon", label: "Zone tampon", desc: "Polygone à distance fixe autour de chaque objet (points, lignes ou surfaces).",
    fields: [{ k: "couche", type: "layer", label: "Couche" }, { k: "distance", type: "num", label: "Distance (m)", def: 500 }],
    run: ({ couche, distance }, x) => {
      const feats = couche.data.features.slice(0, 2000).map((f) => ({ type: "Feature", properties: { ...f.properties, tampon_m: distance }, geometry: G.buffer(f.geometry, Number(distance)) })).filter((f) => f.geometry);
      return x.add(`${couche.name} — tampon ${G.fmtM(distance)}`, feats, derived(couche));
    } },
  { id: "enveloppe", label: "Enveloppe convexe", desc: "Plus petit polygone convexe contenant les objets (option : un par valeur d'attribut).",
    fields: [{ k: "couche", type: "layer", label: "Couche" }, { k: "par", type: "text", label: "Grouper par attribut (facultatif)", opt: true }],
    run: ({ couche, par }, x) => {
      const groups = {};
      for (const f of couche.data.features) (groups[par ? String(f.properties?.[par] ?? "—") : "tout"] ||= []).push(...G.coordsOf(f.geometry));
      const feats = Object.entries(groups).map(([k, c]) => { const h = G.convexHull(c); return h && { type: "Feature", properties: { name: par ? k : couche.name, objets: c.length, surface_m2: Math.round(G.area(h)) }, geometry: h }; }).filter(Boolean);
      return x.add(`${couche.name} — enveloppe${par ? ` par ${par}` : ""}`, feats, derived(couche));
    } },
  { id: "centroides", label: "Centroïdes", desc: "Un point au centre de chaque objet (attributs conservés).",
    fields: [{ k: "couche", type: "layer", label: "Couche" }],
    run: ({ couche }, x) => x.add(`${couche.name} — centroïdes`, pts(couche).map(([f, c]) => G.point(c, { ...f.properties })), derived(couche)) },
  { id: "centre_moyen", label: "Centre moyen", desc: "Point moyen de la couche, pondéré par un attribut numérique si indiqué.",
    fields: [{ k: "couche", type: "layer", label: "Couche" }, { k: "poids", type: "text", label: "Attribut de pondération (facultatif)", opt: true }],
    run: ({ couche, poids }, x) => { const c = G.centerMean(couche.data.features, poids || null); if (!c) throw new Error("Couche vide."); return x.add(`${couche.name} — centre moyen`, [G.point(c, { name: "Centre moyen", lat: +c[1].toFixed(6), lon: +c[0].toFixed(6) })], derived(couche)); } },
  { id: "emprise", label: "Emprise (rectangle)", desc: "Rectangle englobant la couche.",
    fields: [{ k: "couche", type: "layer", label: "Couche" }],
    run: ({ couche }, x) => { const b = G.bbox(couche.data); const g = G.bboxPolygon(b); return x.add(`${couche.name} — emprise`, [{ type: "Feature", properties: { name: "Emprise", ouest: b[0], sud: b[1], est: b[2], nord: b[3], surface_m2: Math.round(G.area(g)) }, geometry: g }], derived(couche)); } },
  { id: "simplifier", label: "Simplifier", desc: "Allège lignes et contours (Douglas-Peucker) : les sommets à moins de la tolérance de la forme générale disparaissent.",
    fields: [{ k: "couche", type: "layer", label: "Couche" }, { k: "tolerance", type: "num", label: "Tolérance (m)", def: 20 }],
    run: ({ couche, tolerance }, x) => {
      let before = 0, after = 0;
      const feats = couche.data.features.map((f) => { const g = G.simplify(f.geometry, Number(tolerance)); before += G.coordsOf(f.geometry).length; after += G.coordsOf(g).length; return { ...f, geometry: g }; });
      const l = x.add(`${couche.name} — simplifiée ${G.fmtM(tolerance)}`, feats, derived(couche));
      return `${l.msg} (${before} → ${after} sommets).`;
    } },
  { id: "mesures", label: "Calculer longueurs, surfaces et coordonnées", desc: "Ajoute aux objets les attributs longueur_m, surface_m2, lat, lon.",
    fields: [{ k: "couche", type: "layer", label: "Couche" }],
    run: ({ couche }, x) => {
      for (const f of couche.data.features) {
        const c = G.centroid(f.geometry), len = G.length(f.geometry), ar = G.area(f.geometry);
        f.properties = { ...f.properties, ...(len ? { longueur_m: Math.round(len) } : {}), ...(ar ? { surface_m2: Math.round(ar) } : {}), ...(c ? { lat: +c[1].toFixed(6), lon: +c[0].toFixed(6) } : {}) };
      }
      x.update(couche);
      const len = couche.data.features.reduce((s, f) => s + (f.properties.longueur_m || 0), 0), ar = couche.data.features.reduce((s, f) => s + (f.properties.surface_m2 || 0), 0);
      return `Attributs ajoutés à ${couche.name}${len ? ` · longueur totale ${G.fmtM(len)}` : ""}${ar ? ` · surface totale ${G.fmtA(ar)}` : ""}.`;
    } },
  { id: "dans_zones", label: "Objets dans des zones", desc: "Garde les objets d'une couche situés dans les polygones d'une autre.",
    fields: [{ k: "couche", type: "layer", label: "Objets" }, { k: "zones", type: "layer", label: "Zones (polygones)" }, { k: "inverse", type: "bool", label: "Garder ceux HORS des zones", opt: true }],
    run: ({ couche, zones, inverse }, x) => {
      const Z = zones.data.features.map((f) => f.geometry);
      const out = pts(couche).filter(([, c]) => Z.some((g) => G.pointInPolygon(c, g)) !== !!inverse).map(([f]) => f);
      return x.add(`${couche.name} ${inverse ? "hors de" : "dans"} ${zones.name}`, out, derived(couche));
    } },
  { id: "jointure", label: "Jointure spatiale", desc: "Ajoute à chaque objet un attribut de la zone qui le contient (ex. nom de la commune).",
    fields: [{ k: "couche", type: "layer", label: "Objets" }, { k: "zones", type: "layer", label: "Zones (polygones)" }, { k: "attribut", type: "text", label: "Attribut de la zone à recopier", def: "nom" }],
    run: ({ couche, zones, attribut }, x) => {
      let n = 0;
      for (const [f, c] of pts(couche)) {
        const z = zones.data.features.find((zf) => G.pointInPolygon(c, zf.geometry));
        const v = z ? (z.properties?.[attribut] ?? G.label(z)) : null;
        f.properties = { ...f.properties, [`zone_${attribut}`]: v };
        if (v != null) n++;
      }
      x.update(couche);
      return `${n}/${couche.data.features.length} objets rattachés à une zone (attribut zone_${attribut}).`;
    } },
  { id: "compter", label: "Compter par zone", desc: "Nombre d'objets d'une couche dans chaque polygone d'une autre (attribut nb), avec densité au km².",
    fields: [{ k: "zones", type: "layer", label: "Zones (polygones)" }, { k: "couche", type: "layer", label: "Objets à compter" }],
    run: ({ zones, couche }, x) => {
      const P = pts(couche).map(([, c]) => c);
      for (const f of zones.data.features) {
        const nb = P.filter((p) => G.pointInPolygon(p, f.geometry)).length, a = G.area(f.geometry);
        f.properties = { ...f.properties, nb, ...(a ? { densite_km2: +(nb / (a / 1e6)).toFixed(2) } : {}) };
      }
      x.update(zones);
      return zones.data.features.slice().sort((a, b) => b.properties.nb - a.properties.nb).slice(0, 8).map((f) => `${G.label(f) || "zone"} : ${f.properties.nb}`).join("\n");
    } },
  { id: "plus_proche", label: "Plus proche voisin", desc: "Relie chaque objet A à l'objet B le plus proche (ligne + distance).",
    fields: [{ k: "couche", type: "layer", label: "Couche A (départs)" }, { k: "cible", type: "layer", label: "Couche B (cibles)" }],
    run: ({ couche, cible }, x) => {
      const B = cible.data.features;
      const feats = pts(couche).slice(0, 1000).map(([f, c]) => {
        let best = null;
        for (const b of B) { const r = G.nearestPointOn(b.geometry, c); if (r && (!best || r.distance < best.r.distance)) best = { r, b }; }
        return best && { type: "Feature", properties: { de: G.label(f) || "", vers: G.label(best.b) || "", distance_m: Math.round(best.r.distance) }, geometry: { type: "LineString", coordinates: [c, best.r.point] } };
      }).filter(Boolean);
      const d = feats.map((f) => f.properties.distance_m);
      const l = x.add(`${couche.name} → ${cible.name} (plus proche)`, feats, derived(couche));
      return d.length ? `${l.msg} Distance moyenne ${G.fmtM(d.reduce((a, b) => a + b, 0) / d.length)}, max ${G.fmtM(Math.max(...d))}.` : l.msg;
    } },
  { id: "liaisons", label: "Lignes vers un lieu", desc: "Trace une liaison à vol d'oiseau entre un lieu et chaque objet, avec distance et direction.",
    fields: [{ k: "couche", type: "layer", label: "Couche" }, { k: "lieu", type: "text", label: "Lieu (vide = centre de la vue)", opt: true }],
    run: async ({ couche, lieu }, x) => {
      const p = await resolvePlace(lieu, x.ctx);
      const feats = pts(couche).slice(0, 1000).map(([f, c]) => ({ type: "Feature", properties: { vers: G.label(f) || "", distance_m: Math.round(G.distance(p.coord, c)), direction: G.cardinal(G.bearing(p.coord, c)) }, geometry: G.greatCircle(p.coord, c) }));
      return x.add(`Liaisons ${p.label} → ${couche.name}`, feats, derived(couche));
    } },
  { id: "grille", label: "Grille d'analyse", desc: "Grille hexagonale ou carrée sur la couche (ou la vue), avec le nombre d'objets par cellule.",
    fields: [{ k: "couche", type: "layer", label: "Objets à compter (facultatif)", opt: true }, { k: "taille", type: "num", label: "Taille des cellules (m)", def: 500 }, { k: "forme", type: "select", label: "Forme", opts: [["hex", "Hexagones"], ["square", "Carrés"]], def: "hex" }, { k: "vides", type: "bool", label: "Garder les cellules vides", opt: true }],
    run: ({ couche, taille, forme, vides }, x) => {
      const bb = couche ? G.bbox(couche.data) : x.ctx.bbox();
      const cells = G.grid(bb, Number(taille), forme);
      const P = couche ? pts(couche).map(([, c]) => c) : [];
      let feats = cells.map((g) => ({ type: "Feature", properties: couche ? { nb: P.filter((p) => G.pointInPolygon(p, g)).length } : {}, geometry: g }));
      if (couche && !vides) feats = feats.filter((f) => f.properties.nb);
      return x.add(`Grille ${forme === "square" ? "carrée" : "hexagonale"} ${G.fmtM(taille)}${couche ? ` — ${couche.name}` : ""}`, feats, couche ? derived(couche) : SELF);
    } },
  { id: "kmeans", label: "Regrouper (k-moyennes)", desc: "Répartit les objets en k groupes proches (attribut groupe) et dessine l'enveloppe de chaque groupe.",
    fields: [{ k: "couche", type: "layer", label: "Couche" }, { k: "k", type: "num", label: "Nombre de groupes", def: 5 }],
    run: ({ couche, k }, x) => {
      const P = pts(couche);
      const a = G.kmeans(P.map(([, c]) => c), Number(k));
      P.forEach(([f], i) => { f.properties = { ...f.properties, groupe: a[i] + 1 }; });
      x.update(couche);
      const hulls = [...new Set(a)].map((g) => { const c = P.filter((_, i) => a[i] === g).map(([, c]) => c); const h = G.convexHull(c); return h && { type: "Feature", properties: { name: `Groupe ${g + 1}`, groupe: g + 1, objets: c.length }, geometry: h }; }).filter(Boolean);
      x.add(`${couche.name} — ${k} groupes`, hulls, derived(couche));
      return `${couche.name} : attribut « groupe » (1 à ${k}) ajouté ; enveloppes des groupes créées.`;
    } },
  { id: "dbscan", label: "Détecter les agrégats (DBSCAN)", desc: "Repère les concentrations : objets à moins de « distance » d'au moins « minimum » voisins.",
    fields: [{ k: "couche", type: "layer", label: "Couche" }, { k: "distance", type: "num", label: "Distance de voisinage (m)", def: 300 }, { k: "minimum", type: "num", label: "Voisins minimum", def: 3 }],
    run: ({ couche, distance, minimum }, x) => {
      const P = pts(couche);
      if (P.length > 4000) throw new Error("4000 objets au plus pour DBSCAN.");
      const lab = G.dbscan(P.map(([, c]) => c), Number(distance), Number(minimum));
      P.forEach(([f], i) => { f.properties = { ...f.properties, agregat: lab[i] < 0 ? null : lab[i] + 1 }; });
      x.update(couche);
      const ids = [...new Set(lab.filter((v) => v >= 0))];
      const hulls = ids.map((g) => { const c = P.filter((_, i) => lab[i] === g).map(([, c]) => c); const h = c.length >= 3 ? G.convexHull(c) : null; return h && { type: "Feature", properties: { name: `Agrégat ${g + 1}`, objets: c.length }, geometry: h }; }).filter(Boolean);
      if (hulls.length) x.add(`${couche.name} — agrégats`, hulls, derived(couche));
      return `${ids.length} agrégat(s), ${lab.filter((v) => v < 0).length} objet(s) isolé(s).`;
    } },
  { id: "decouper", label: "Découper par une zone", desc: "Garde la partie des objets située dans une zone (surfaces : zone convexe pour un résultat exact).",
    fields: [{ k: "couche", type: "layer", label: "Couche à découper" }, { k: "zone", type: "layer", label: "Zone (1er polygone utilisé)" }],
    run: ({ couche, zone }, x) => {
      const z = zone.data.features.find((f) => f.geometry && /Polygon/.test(f.geometry.type));
      if (!z) throw new Error("La zone doit contenir un polygone.");
      const feats = couche.data.features.map((f) => { const g = G.clip(f.geometry, z.geometry); return g && { ...f, geometry: g }; }).filter(Boolean);
      return x.add(`${couche.name} découpée par ${zone.name}`, feats, derived(couche));
    } },
  { id: "intersections", label: "Intersections de lignes", desc: "Points où les lignes de deux couches se croisent (ex. routes × cours d'eau).",
    fields: [{ k: "couche", type: "layer", label: "Lignes A" }, { k: "autre", type: "layer", label: "Lignes B" }],
    run: ({ couche, autre }, x) => {
      const out = [];
      const A = couche.data.features.slice(0, 1500), B = autre.data.features.slice(0, 1500);
      const bbs = B.map((f) => G.bbox(f.geometry));
      for (const a of A) {
        const ba = G.bbox(a.geometry);
        B.forEach((b, j) => {
          const bb = bbs[j];
          if (!ba || !bb || ba[0] > bb[2] || ba[2] < bb[0] || ba[1] > bb[3] || ba[3] < bb[1]) return;
          for (const p of G.lineIntersect(a.geometry, b.geometry)) out.push(G.point(p, { a: G.label(a) || "", b: G.label(b) || "" }));
        });
        if (out.length > 5000) break;
      }
      return x.add(`Intersections ${couche.name} × ${autre.name}`, out, derived(couche));
    } },
  { id: "jalons", label: "Points le long d'une ligne", desc: "Place un point tous les N mètres le long des lignes (bornes, jalons).",
    fields: [{ k: "couche", type: "layer", label: "Lignes" }, { k: "intervalle", type: "num", label: "Intervalle (m)", def: 1000 }],
    run: ({ couche, intervalle }, x) => {
      const out = [], step = Math.max(1, Number(intervalle));
      for (const f of couche.data.features) {
        const L = G.length(f.geometry);
        if (!L || f.geometry.type.includes("Polygon")) continue;
        for (let d = 0; d <= L && out.length < 5000; d += step) { const p = G.along(f.geometry, d); if (p) out.push(G.point(p, { name: G.fmtM(d), pk_m: Math.round(d), ligne: G.label(f) || "" })); }
      }
      return x.add(`${couche.name} — jalons ${G.fmtM(step)}`, out, derived(couche));
    } },
  { id: "interpoler", label: "Interpoler une valeur (IDW)", desc: "Estime un attribut numérique sur une grille à partir de points mesurés (pondération inverse à la distance).",
    fields: [{ k: "couche", type: "layer", label: "Points mesurés" }, { k: "attribut", type: "text", label: "Attribut numérique" }, { k: "taille", type: "num", label: "Taille des cellules (m)", def: 500 }],
    run: ({ couche, attribut, taille }, x) => {
      const S = pts(couche).map(([f, c]) => [c, Number(f.properties?.[attribut])]).filter(([, v]) => Number.isFinite(v));
      if (S.length < 3) throw new Error(`Au moins 3 points avec une valeur « ${attribut} ».`);
      const cells = G.grid(G.bbox(couche.data), Number(taille), "square", 4000);
      const feats = cells.map((g) => ({ type: "Feature", properties: { [attribut]: +G.idw(G.centroid(g), S).toFixed(3) }, geometry: g }));
      return x.add(`${attribut} interpolé (${G.fmtM(taille)})`, feats, derived(couche));
    } },
];

/** Exécute une opération avec des arguments (références de couches résolues). */
export async function runOp(id, args, ctx) {
  const op = OPS.find((o) => o.id === id);
  if (!op) throw new Error(`Opération inconnue : ${id}`);
  const a = {};
  for (const f of op.fields) {
    let v = args[f.k];
    if (f.type === "layer") {
      if (v == null || v === "") { if (f.opt) continue; throw new Error(`${f.label} : choisissez une couche.`); }
      const l = typeof v === "object" ? v : ctx.findLayer(v);
      if (!l) throw new Error(`Couche introuvable : « ${v} ».`);
      v = l;
    } else if (f.type === "num") { v = v === "" || v == null ? f.def : Number(v); if (!Number.isFinite(v) || v <= 0) throw new Error(`${f.label} : nombre positif attendu.`); }
    else if (f.type === "bool") v = v === true || v === "true" || v === "on";
    else if (v == null || v === "") { if (f.def != null) v = f.def; else if (!f.opt) throw new Error(`${f.label} : valeur requise.`); }
    a[f.k] = v;
  }
  const x = {
    ctx,
    add: (name, features, credit) => {
      if (!features.length) throw new Error("Aucun objet en résultat.");
      const l = ctx.addLayer({ name, data: G.fc(features), credit });
      ctx.fitTo(G.bbox(l.data));
      return Object.assign(l, { msg: `${features.length} objet(s) → couche ${l.id} « ${name} »` });
    },
    update: (l) => ctx.updateLayer(l, {}),
  };
  const r = await op.run(a, x);
  return typeof r === "string" ? r : r?.msg || "Fait.";
}

// =====================================================================================
// Interface de l'onglet
// =====================================================================================
export function mountSig(ctx) {
  const pane = document.querySelector('[data-pane="sig"]');
  const $ = (sel) => pane.querySelector(sel);
  const layerOptions = (opt) => `${opt ? `<option value="">${esc(tt("— aucune —"))}</option>` : ""}${ctx.layers.map((l) => `<option value="${l.id}">${esc(l.name)} (${l.data.features.length})</option>`).join("")}`;

  pane.innerHTML = `
    <div class="sig-sec">
      <h3>${esc(tt("Mesurer"))}</h3>
      <div class="actions">
        <button class="btn-soft" data-measure="line">${esc(tt("Distance"))}</button>
        <button class="btn-soft" data-measure="area">${esc(tt("Surface"))}</button>
        <button class="btn-soft" data-measure="save" hidden>${esc(tt("Garder en couche"))}</button>
        <button class="btn-ico" data-measure="clear" title="${esc(tt("Effacer"))}" hidden>✕</button>
      </div>
      <p class="muted" id="sig-measure-out">${esc(tt("Cliquez sur la carte pour poser des points ; double-clic ou Entrée pour terminer, Échap pour annuler."))}</p>
    </div>

    <div class="sig-sec">
      <h3>${esc(tt("Itinéraire"))}</h3>
      <div class="sig-place"><input class="input" id="rt-from" placeholder="${esc(tt("Départ (lieu, adresse ou lat, lon)"))}" /><button class="btn-ico" data-pick="rt-from" title="${esc(tt("Choisir sur la carte"))}">◎</button></div>
      <textarea class="input" id="rt-via" rows="2" placeholder="${esc(tt("Étapes intermédiaires (une par ligne, facultatif)"))}"></textarea>
      <div class="sig-place"><input class="input" id="rt-to" placeholder="${esc(tt("Arrivée"))}" /><button class="btn-ico" data-pick="rt-to" title="${esc(tt("Choisir sur la carte"))}">◎</button></div>
      <div class="row2">
        <select class="input" id="rt-mode"><option value="car">${esc(tt("Voiture"))}</option><option value="pedestrian">${esc(tt("À pied"))}</option><option value="bike">${esc(tt("Vélo (estimé)"))}</option></select>
        <select class="input" id="rt-opt"><option value="fastest">${esc(tt("Plus rapide"))}</option><option value="shortest">${esc(tt("Plus court"))}</option></select>
      </div>
      <label class="chk"><input type="checkbox" id="rt-optimize" /> ${esc(tt("Optimiser l'ordre des étapes"))}</label>
      <label class="chk"><input type="checkbox" id="rt-loop" /> ${esc(tt("Boucle (retour au départ)"))}</label>
      <div class="actions">
        <button class="btn-primary" id="rt-go">${esc(tt("Calculer"))}</button>
        <button class="btn-soft" id="rt-iso">${esc(tt("Zone accessible…"))}</button>
        <button class="btn-soft" id="rt-swap" title="${esc(tt("Inverser départ et arrivée"))}">⇅</button>
      </div>
      <div id="rt-out"></div>
    </div>

    <div class="sig-sec">
      <h3>${esc(tt("Géotraitements"))}</h3>
      <select class="input" id="op-id">${OPS.map((o) => `<option value="${o.id}">${esc(tt(o.label))}</option>`).join("")}</select>
      <p class="muted" id="op-desc"></p>
      <div id="op-fields" class="sig-fields"></div>
      <button class="btn-primary" id="op-go">${esc(tt("Exécuter"))}</button>
      <p class="muted" id="op-out"></p>
    </div>

    <div class="sig-sec">
      <h3>${esc(tt("Carte de localisation (PDF)"))}</h3>
      <p class="muted">${esc(tt("Repères, échelle, nord, carte de situation et accès calculés automatiquement ; l'IA rédige le texte à partir de ces données."))}</p>
      <div class="sig-place"><input class="input" id="pdf-place" placeholder="${esc(tt("Lieu à localiser"))}" /><button class="btn-ico" data-pick="pdf-place" title="${esc(tt("Choisir sur la carte"))}">◎</button></div>
      <input class="input" id="pdf-title" placeholder="${esc(tt("Titre (facultatif)"))}" />
      <input class="input" id="pdf-from" placeholder="${esc(tt("Itinéraire depuis (facultatif : gare, ville…)"))}" />
      <div class="row2">
        <select class="input" id="pdf-format"><option value="paysage">${esc(tt("A4 paysage"))}</option><option value="portrait">${esc(tt("A4 portrait"))}</option></select>
        <select class="input" id="pdf-radius"><option value="400">${esc(tt("Repères à 400 m"))}</option><option value="800" selected>${esc(tt("Repères à 800 m"))}</option><option value="1500">${esc(tt("Repères à 1,5 km"))}</option></select>
      </div>
      <button class="btn-primary" id="pdf-go">${esc(tt("Générer le PDF"))}</button>
      <p class="muted" id="pdf-out"></p>
    </div>`;

  // ---- Mesure interactive ----------------------------------------------------------
  const M = { mode: null, pts: [], hover: null, done: false };
  const SRC = "__measure";
  const ensureSrc = () => {
    const map = ctx.map;
    if (!map.isStyleLoaded()) return false;
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: "geojson", data: G.fc([]) });
      map.addLayer({ id: `${SRC}-fill`, type: "fill", source: SRC, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#ff375f", "fill-opacity": 0.15 } });
      map.addLayer({ id: `${SRC}-line`, type: "line", source: SRC, filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": "#ff375f", "line-width": 2.5, "line-dasharray": [2, 1] } });
      map.addLayer({ id: `${SRC}-pt`, type: "circle", source: SRC, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 4.5, "circle-color": "#fff", "circle-stroke-color": "#ff375f", "circle-stroke-width": 2 } });
    }
    return true;
  };
  const measureGeom = () => {
    const p = M.done || !M.hover ? M.pts : [...M.pts, M.hover];
    if (M.mode === "area" && p.length >= 3) return { type: "Polygon", coordinates: [[...p, p[0]]] };
    if (p.length >= 2) return { type: "LineString", coordinates: p };
    return null;
  };
  function drawMeasure() {
    if (!ensureSrc()) return;
    const g = measureGeom();
    const feats = [...M.pts.map((c) => G.point(c)), ...(g ? [{ type: "Feature", properties: {}, geometry: g }] : [])];
    ctx.map.getSource(SRC).setData(G.fc(feats));
    const out = $("#sig-measure-out");
    if (!g) { out.textContent = M.mode ? tt("Cliquez pour poser le premier point.") : out.textContent; return; }
    if (M.mode === "area" && g.type === "Polygon") out.textContent = `${tt("Surface")} : ${G.fmtA(G.area(g))} · ${tt("périmètre")} ${G.fmtM(G.length(g))}`;
    else {
      const segs = g.coordinates.slice(1).map((p, i) => G.distance(g.coordinates[i], p));
      const last = g.coordinates.length >= 2 ? G.bearing(g.coordinates.at(-2), g.coordinates.at(-1)) : 0;
      out.textContent = `${tt("Distance")} : ${G.fmtM(segs.reduce((a, b) => a + b, 0))}${segs.length > 1 ? ` (${segs.length} ${tt("segments")}, ${tt("dernier")} ${G.fmtM(segs.at(-1))})` : ""} · ${tt("cap")} ${Math.round(last)}° ${G.cardinal(last)}`;
    }
  }
  function startMeasure(mode) {
    stopPick();
    Object.assign(M, { mode, pts: [], hover: null, done: false });
    ctx.setInteractionMode("measure");
    ctx.map.doubleClickZoom.disable();
    ctx.map.getCanvas().style.cursor = "crosshair";
    pane.querySelectorAll("[data-measure=line],[data-measure=area]").forEach((b) => b.classList.toggle("is-on", b.dataset.measure === mode));
    $("[data-measure=clear]").hidden = false; $("[data-measure=save]").hidden = true;
    drawMeasure();
  }
  function finishMeasure() {
    if (!M.mode) return;
    M.done = true; M.hover = null;
    ctx.setInteractionMode(null);
    ctx.map.getCanvas().style.cursor = "";
    setTimeout(() => ctx.map.doubleClickZoom.enable(), 300);
    $("[data-measure=save]").hidden = !measureGeom();
    drawMeasure();
  }
  function clearMeasure() {
    Object.assign(M, { mode: null, pts: [], hover: null, done: false });
    ctx.setInteractionMode(null);
    ctx.map.getCanvas().style.cursor = "";
    ctx.map.doubleClickZoom.enable();
    if (ctx.map.getSource(SRC)) ctx.map.getSource(SRC).setData(G.fc([]));
    pane.querySelectorAll("[data-measure]").forEach((b) => b.classList.remove("is-on"));
    $("[data-measure=clear]").hidden = true; $("[data-measure=save]").hidden = true;
    $("#sig-measure-out").textContent = tt("Cliquez sur la carte pour poser des points ; double-clic ou Entrée pour terminer, Échap pour annuler.");
  }
  pane.querySelectorAll("[data-measure]").forEach((b) => b.addEventListener("click", () => {
    const m = b.dataset.measure;
    if (m === "clear") return clearMeasure();
    if (m === "save") {
      const g = measureGeom(); if (!g) return;
      const props = g.type === "Polygon" ? { name: tt("Surface mesurée"), surface_m2: Math.round(G.area(g)), perimetre_m: Math.round(G.length(g)) } : { name: tt("Distance mesurée"), longueur_m: Math.round(G.length(g)) };
      ctx.appendOrCreate(tt("Mesures"), [{ type: "Feature", properties: props, geometry: g }], { source: "Saisie dans Lumen", license: "—", url: "" });
      clearMeasure(); ctx.toast(tt("Mesure enregistrée dans la couche « Mesures »."));
      return;
    }
    startMeasure(m);
  }));

  // ---- Choix d'un point sur la carte -------------------------------------------------
  let picking = null;
  function stopPick() { if (picking) { picking = null; ctx.setInteractionMode(null); ctx.map.getCanvas().style.cursor = ""; pane.querySelectorAll("[data-pick]").forEach((b) => b.classList.remove("is-on")); } }
  pane.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
    if (picking === b.dataset.pick) return stopPick();
    if (M.mode && !M.done) clearMeasure();
    stopPick();
    picking = b.dataset.pick;
    b.classList.add("is-on");
    ctx.setInteractionMode("pick");
    ctx.map.getCanvas().style.cursor = "crosshair";
    ctx.toast(tt("Cliquez sur la carte pour choisir le point."));
  }));

  ctx.map.on("click", (e) => {
    if (picking) { $(`#${picking}`).value = `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`; stopPick(); return; }
    if (!M.mode || M.done) return;
    M.pts.push([e.lngLat.lng, e.lngLat.lat]);
    drawMeasure();
  });
  ctx.map.on("dblclick", (e) => { if (M.mode && !M.done) { e.preventDefault(); M.pts.pop(); finishMeasure(); } });
  ctx.map.on("mousemove", (e) => { if (M.mode && !M.done && M.pts.length) { M.hover = [e.lngLat.lng, e.lngLat.lat]; drawMeasure(); } });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, select")) return;
    if (e.key === "Escape") { if (picking) stopPick(); else if (M.mode && !M.done) clearMeasure(); }
    if (e.key === "Enter" && M.mode && !M.done) finishMeasure();
  });
  // Un changement de fond efface les sources : on redessine la mesure en cours.
  ctx.map.on("style.load", () => { if (M.mode) drawMeasure(); });

  // ---- Itinéraire ------------------------------------------------------------------
  const rtOut = $("#rt-out");
  $("#rt-swap").onclick = () => { const a = $("#rt-from").value; $("#rt-from").value = $("#rt-to").value; $("#rt-to").value = a; };
  $("#rt-go").onclick = async () => {
    const lines = [$("#rt-from").value, ...$("#rt-via").value.split("\n"), $("#rt-to").value].map((s) => s.trim()).filter(Boolean);
    if (lines.length < 2) { ctx.toast(tt("Indiquez au moins un départ et une arrivée.")); return; }
    ctx.busy(tt("Calcul de l'itinéraire…"));
    try {
      const places = [];
      for (const s of lines) places.push(await resolvePlace(s, ctx));
      const r = await route(places.map((p) => p.coord), { mode: $("#rt-mode").value, optimization: $("#rt-opt").value, optimize: $("#rt-optimize").checked, loop: $("#rt-loop").checked, lang: ctx.lang() });
      const order = r.order.map((i) => places[i]);
      showRoute(r, order);
    } catch (e) { rtOut.innerHTML = `<p class="muted">${esc(e.message || e)}</p>`; }
    finally { ctx.busy(null); }
  };
  function showRoute(r, order) {
    const seq = $("#rt-loop").checked ? [...order, order[0]] : order;
    const name = `${seq[0].label} → ${seq.at(-1).label}`;
    const stops = seq.map((p, i) => G.point(p.coord, { name: `${i === 0 ? "Départ" : i === seq.length - 1 ? "Arrivée" : `Étape ${i}`} — ${p.label}`, ordre: i }));
    const props = { name, distance_m: Math.round(r.distance), duree_min: Math.round(r.duration), mode: r.mode };
    const l = ctx.addLayer({ name: `${tt("Itinéraire")} ${name}`, data: G.fc([{ type: "Feature", properties: props, geometry: r.geometry }, ...stops]), credit: IGN_CREDIT });
    ctx.fitTo(G.bbox(l.data));
    rtOut.innerHTML = `<div class="rt-sum"><b>${esc(routeSummary(r, ctx.lang()))}</b>${r.order.some((v, i) => v !== i) ? `<br><small>${esc(tt("Ordre optimisé"))} : ${order.map((p) => esc(p.label)).join(" → ")}</small>` : ""}</div>
      ${r.legs.length > 1 ? `<ol class="rt-legs">${r.legs.map((g, i) => `<li>${esc(seq[i].label)} → ${esc(seq[i + 1]?.label || "")} : ${G.fmtM(g.distance)}, ${G.fmtMin(g.duration)}</li>`).join("")}</ol>` : ""}
      <details open><summary>${r.steps.length} ${esc(tt("instructions"))}</summary><ol class="rt-steps">${r.steps.map((s) => `<li>${esc(s.text)}<small>${s.distance > 1 ? G.fmtM(s.distance) : ""}</small></li>`).join("")}</ol></details>
      <p class="credit">© ${esc(IGN_CREDIT.source)} — ${esc(IGN_CREDIT.license)}</p>`;
  }
  $("#rt-iso").onclick = async () => {
    const from = $("#rt-from").value.trim();
    const v = prompt(tt("Zone accessible depuis le départ : durée en minutes (ex. 15) ou distance (ex. 2km)"), "15");
    if (!v) return;
    ctx.busy(tt("Calcul de la zone accessible…"));
    try {
      const p = await resolvePlace(from, ctx);
      const km = String(v).match(/([\d.,]+)\s*km/i), mm = String(v).match(/([\d.,]+)\s*m\b/i);
      const opts = km ? { meters: parseFloat(km[1].replace(",", ".")) * 1000 } : mm ? { meters: parseFloat(mm[1]) } : { minutes: parseFloat(v) };
      const mode = $("#rt-mode").value;
      const g = await isoline(p.coord, { ...opts, mode });
      const what = opts.minutes ? `${opts.minutes} min` : G.fmtM(opts.meters);
      const l = ctx.addLayer({ name: `${tt("Zone accessible")} ${what} (${$("#rt-mode").selectedOptions[0].textContent}) — ${p.label}`, data: G.fc([{ type: "Feature", properties: { name: p.label, surface_m2: Math.round(G.area(g)) }, geometry: g }]), credit: IGN_CREDIT });
      ctx.fitTo(G.bbox(l.data));
      rtOut.innerHTML = `<p>${esc(tt("Zone accessible"))} : <b>${G.fmtA(G.area(g))}</b></p>`;
    } catch (e) { ctx.toast(e.message || String(e)); } finally { ctx.busy(null); }
  };

  // ---- Géotraitements ----------------------------------------------------------------
  function renderOp() {
    const op = OPS.find((o) => o.id === $("#op-id").value);
    $("#op-desc").textContent = tt(op.desc);
    $("#op-fields").innerHTML = op.fields.map((f) => {
      const id = `op-f-${f.k}`;
      if (f.type === "layer") return `<label>${esc(tt(f.label))}<select class="input" id="${id}">${layerOptions(f.opt)}</select></label>`;
      if (f.type === "select") return `<label>${esc(tt(f.label))}<select class="input" id="${id}">${f.opts.map(([v, t]) => `<option value="${v}"${v === f.def ? " selected" : ""}>${esc(tt(t))}</option>`).join("")}</select></label>`;
      if (f.type === "bool") return `<label class="chk"><input type="checkbox" id="${id}" /> ${esc(tt(f.label))}</label>`;
      return `<label>${esc(tt(f.label))}<input class="input" id="${id}" ${f.type === "num" ? 'type="number" min="0" step="any"' : ""} value="${esc(f.def ?? "")}" /></label>`;
    }).join("");
    // Deuxième couche différente de la première par défaut.
    const sels = [...$("#op-fields").querySelectorAll("select")].filter((s) => s.id !== "op-f-forme");
    if (sels.length > 1 && ctx.layers.length > 1 && !op.fields.find((f) => `op-f-${f.k}` === sels[1].id)?.opt) sels[1].selectedIndex = 1;
  }
  $("#op-id").onchange = renderOp;
  $("#op-go").onclick = async () => {
    const op = OPS.find((o) => o.id === $("#op-id").value);
    const args = Object.fromEntries(op.fields.map((f) => { const el = $(`#op-f-${f.k}`); return [f.k, f.type === "bool" ? el.checked : el.value]; }));
    ctx.busy(tt(op.label) + "…");
    try { $("#op-out").textContent = await runOp(op.id, args, ctx); }
    catch (e) { $("#op-out").textContent = e.message || String(e); }
    finally { ctx.busy(null); }
  };
  renderOp();

  // ---- PDF ----------------------------------------------------------------------------
  $("#pdf-go").onclick = async () => {
    const lieu = $("#pdf-place").value.trim() || $("#search-input")?.value.trim();
    if (!lieu) { ctx.toast(tt("Indiquez le lieu à localiser.")); return; }
    $("#pdf-go").disabled = true;
    try {
      const msg = await makePdf(ctx, { lieu, titre: $("#pdf-title").value.trim(), depuis: $("#pdf-from").value.trim(), format: $("#pdf-format").value, rayon: Number($("#pdf-radius").value) }, (s) => { $("#pdf-out").textContent = s; ctx.busy(s); });
      $("#pdf-out").textContent = msg;
    } catch (e) { $("#pdf-out").textContent = e.message || String(e); }
    finally { ctx.busy(null); $("#pdf-go").disabled = false; }
  };

  // Nouvelles couches : on met à jour les listes sans perdre les choix en cours.
  const refresh = () => {
    const op = OPS.find((o) => o.id === $("#op-id").value);
    for (const f of op.fields.filter((f) => f.type === "layer")) {
      const sel = $(`#op-f-${f.k}`); if (!sel) continue;
      const v = sel.value; sel.innerHTML = layerOptions(f.opt);
      if ([...sel.options].some((o) => o.value === v)) sel.value = v;
    }
  };
  return { refresh };
}

/** Génère la carte PDF et l'enregistre (sandbox › Cartes/, sinon téléchargement). */
export async function makePdf(ctx, o, onStatus) {
  const r = await locationPdf({ ...ctx, onStatus }, { ...o, lang: ctx.lang() });
  const name = `${String(r.title || "carte").replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 60) || "carte"}.pdf`;
  const saved = await ctx.saveBinary(`Cartes/${name}`, r.bytes, "application/pdf");
  return `${saved} — ${r.landmarks} ${tt("repères")}${r.route ? `, ${tt("itinéraire")} ${r.route}` : ""}${r.ai ? "" : ` (${tt("texte sans IA")})`}.`;
}

export { matrix };
