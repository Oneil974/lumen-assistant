// Lumen XR — « ceinture » d'icônes en relief autour de l'orbe.
//
// Pendant une réponse, les familles d'outils (fichiers, notes, agenda, Kanban,
// météo, web, bases, mémoire…) tournent autour de l'orbe comme une ceinture :
// des icônes sculptées et colorées (xr-design.js), légèrement
// transparentes. Quand Lumen utilise un outil, son icône clignote dans sa
// couleur pendant quelques secondes, puis redevient blanche.
//
// Pas de chargeur SVG : le navigateur échantillonne lui-même chaque tracé
// (`getPointAtLength` gère chemins, arcs, cercles, rectangles…). Chaque trait
// est ensuite épaissi en contour — à la largeur du trait Lucide, avec
// extrémités arrondies — puis extrudé avec un léger biseau.

import * as THREE from "/lib/three.module.js";
import { createSculptedIcon, iconKind } from "/xr-design.js";
import { icon as lucide } from "/lib/icons.js";

const STROKE = 2;          // largeur du trait Lucide (repère 24×24)
const HALF = STROKE / 2;
const SAMPLE = 0.35;       // pas d'échantillonnage le long des tracés
const DEPTH = 1.1;         // épaisseur de l'extrusion (repère 24×24)

/* ------------------------------------------------------------ Géométrie */

/// Points échantillonnés de chaque trait de l'icône : [{ pts, closed }].
function iconStrokes(name) {
  const markup = lucide(name, { stroke: STROKE });
  if (!markup) return [];
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:24px;height:24px;visibility:hidden";
  host.innerHTML = markup;
  document.body.appendChild(host);
  const out = [];
  try {
    for (const el of host.querySelectorAll("path,circle,rect,line,polyline,polygon,ellipse")) {
      let len = 0;
      try { len = el.getTotalLength(); } catch { continue; }
      if (!(len > 0)) continue;
      const n = Math.max(2, Math.ceil(len / SAMPLE));
      let cur = [];
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const p = el.getPointAtLength((len * i) / n);
        const pt = new THREE.Vector2(p.x, p.y);
        // Saut (nouveau sous-tracé « M ») : on coupe.
        if (prev && pt.distanceTo(prev) > SAMPLE * 3) { if (cur.length > 1) out.push(cur); cur = []; }
        if (!prev || pt.distanceTo(prev) > 1e-3) cur.push(pt);
        prev = pt;
      }
      if (cur.length > 1) out.push(cur);
    }
  } finally {
    host.remove();
  }
  return out.map((pts) => {
    const closed = pts.length > 3 && pts[0].distanceTo(pts[pts.length - 1]) < SAMPLE * 1.5;
    if (closed) pts.pop();
    return { pts, closed };
  });
}

/// Décalage d'une polyligne de ±d le long des normales (jonctions en onglet bornées).
function offset(pts, d, closed) {
  const n = pts.length;
  const res = [];
  for (let i = 0; i < n; i++) {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const b = pts[i];
    const c = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const t1 = new THREE.Vector2().subVectors(b, a); const t2 = new THREE.Vector2().subVectors(c, b);
    if (t1.lengthSq() < 1e-8) t1.copy(t2);
    if (t2.lengthSq() < 1e-8) t2.copy(t1);
    t1.normalize(); t2.normalize();
    const nrm = new THREE.Vector2(-(t1.y + t2.y), t1.x + t2.x);
    if (nrm.lengthSq() < 1e-8) nrm.set(-t1.y, t1.x);
    nrm.normalize();
    // Longueur d'onglet, bornée pour les angles aigus.
    const cos = Math.max(0.35, nrm.dot(new THREE.Vector2(-t1.y, t1.x)));
    res.push(b.clone().addScaledVector(nrm, d / cos));
  }
  return res;
}

/// Aire signée (sens de parcours).
const area = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + (p.x * q.y - q.x * p.y); }, 0) / 2;

/// Contour épaissi d'un trait → formes THREE (avec trou pour un trait fermé).
function strokeShapes({ pts, closed }) {
  if (closed) {
    let outer = offset(pts, HALF, true);
    let inner = offset(pts, -HALF, true);
    if (Math.abs(area(outer)) < Math.abs(area(inner))) [outer, inner] = [inner, outer];
    const shape = new THREE.Shape(outer);
    if (Math.abs(area(inner)) > 0.05) shape.holes.push(new THREE.Path(inner.slice().reverse()));
    return [shape];
  }
  const left = offset(pts, HALF, false);
  const right = offset(pts, -HALF, false);
  // Extrémités arrondies (demi-cercles).
  const cap = (center, from, to, steps = 6) => {
    const a0 = Math.atan2(from.y - center.y, from.x - center.x);
    let a1 = Math.atan2(to.y - center.y, to.x - center.x);
    // On tourne toujours du même côté (vers l'extérieur du trait).
    while (a1 > a0) a1 -= Math.PI * 2;
    if (a0 - a1 > Math.PI * 1.5) a1 += Math.PI * 2;
    const out = [];
    for (let i = 1; i < steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      out.push(new THREE.Vector2(center.x + Math.cos(a) * HALF, center.y + Math.sin(a) * HALF));
    }
    return out;
  };
  const endCap = cap(pts[pts.length - 1], left[left.length - 1], right[right.length - 1]);
  const startCap = cap(pts[0], right[0], left[0]);
  return [new THREE.Shape([...left, ...endCap, ...right.reverse(), ...startCap])];
}

const geoCache = new Map();
/// Géométrie extrudée d'une icône Lucide, centrée, de largeur ~1 (unités).
export function iconGeometry(name) {
  if (geoCache.has(name)) return geoCache.get(name);
  const shapes = iconStrokes(name).flatMap(strokeShapes);
  let geo = null;
  if (shapes.length) {
    geo = new THREE.ExtrudeGeometry(shapes, { depth: DEPTH, bevelEnabled: true, bevelThickness: 0.22, bevelSize: 0.18, bevelSegments: 2, curveSegments: 4 });
    geo.scale(1 / 24, -1 / 24, 1 / 24); // repère SVG (y vers le bas) → 3D
    geo.computeBoundingBox();
    const c = geo.boundingBox.getCenter(new THREE.Vector3());
    geo.translate(-c.x, -c.y, -c.z);
    geo.computeVertexNormals();
  }
  geoCache.set(name, geo);
  return geo;
}

/* ------------------------------------------------------------- Ceinture */

// Familles montrées sur la ceinture, avec leur couleur de clignotement.
const FAMILIES = [
  { id: "files", icon: "folder-open", color: 0xffb547 },
  { id: "notes", icon: "notes", color: 0xffe066 },
  { id: "calendar", icon: "calendar", color: 0x4da3ff },
  { id: "kanban", icon: "kanban", color: 0xb58cff },
  { id: "weather", icon: "cloud-sun", color: 0x5fe0ff },
  { id: "web", icon: "globe", color: 0x61f2a0 },
  { id: "data", icon: "database", color: 0xff8f5a },
  { id: "memory", icon: "brain", color: 0xff7eb6 },
  { id: "apps", icon: "layout-grid", color: 0x3fe0c5 },
  { id: "people", icon: "users", color: 0x9fd4ff },
];
/// Outil → famille.
export function toolFamily(name) {
  const n = String(name || "");
  if (/^sandbox_|^search_documents$/.test(n)) return "files";
  if (/^notes_/.test(n)) return "notes";
  if (/kanban/.test(n)) return "kanban";
  if (/agenda|reminder|calendar|^day_overview$/.test(n)) return "calendar";
  if (/^weather_now$|air_quality/.test(n)) return "weather";
  if (/^web_|news_headlines/.test(n)) return "web";
  if (/^(query_tables|tables_list)$/.test(n)) return "data";
  if (/^memory_/.test(n)) return "memory";
  if (/^(search_personal_data|mail_)/.test(n) || /contacts/.test(n)) return "people";
  if (/^(app_data|apps_|lumen_search$)/.test(n)) return "apps";
  return null;
}

/**
 * @param {THREE.Object3D} parent  repère où poser la ceinture (world)
 */
export function createToolBelt(parent) {
  const group = new THREE.Group();
  group.visible = false;
  parent.add(group);
  // Éclairage doux propre à la ceinture : le reste de la scène (matériaux non
  // éclairés, shaders de l'orbe) n'en est pas affecté.
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8fa8, 1.1);
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(0.4, 1, 0.8);
  parent.add(hemi, key);

  const items = FAMILIES.map((f) => {
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff, transparent: true, opacity: 0.72, roughness: 0.3, metalness: 0.05,
      emissive: new THREE.Color(f.color), emissiveIntensity: 0, depthWrite: true,
    });
    const holder = new THREE.Group();
    const mesh=createSculptedIcon(iconKind(f.icon),{color:f.color});
    const surfaces=[];
    mesh.traverse(o=>{if(o.material){o.material=o.material.clone();o.material.userData.xrShared=false;surfaces.push({material:o.material,opacity:o.material.opacity,emission:o.material.emissiveIntensity || 0});}});
    mesh.renderOrder = 6;
    holder.add(mesh);
    group.add(holder);
    return { ...f, holder, mesh, material, surfaces, flashUntil: 0, flashStart: 0 };
  });

  let visibleUntil = 0;
  let fade = 0; // 0 → 1 (apparition / disparition douce)
  let spin = 0;

  return {
    setLighting(estimate) {
      if(!estimate){key.color.setHex(0xffffff);key.intensity=1.4;key.position.set(.4,1,.8);hemi.intensity=1.1;return;}
      const rgb=estimate.primaryLightIntensity,dir=estimate.primaryLightDirection;
      const peak=Math.max(rgb.x,rgb.y,rgb.z);if(!Number.isFinite(peak) || peak<.001)return;
      key.color.setRGB(Math.max(.35,rgb.x/peak),Math.max(.35,rgb.y/peak),Math.max(.35,rgb.z/peak));
      key.intensity=Math.min(2.4,Math.max(.9,.9+Math.log1p(peak)*.13));
      if(dir)key.position.set(dir.x,Math.max(.2,dir.y),dir.z);
      hemi.intensity=.8+key.intensity*.22;
    },
    /** Lumen travaille : la ceinture apparaît (et reste tant que c'est le cas). */
    busy(on) { if (on) visibleUntil = Infinity; else if (visibleUntil === Infinity) visibleUntil = performance.now() + 3500; },
    /** Un outil vient d'être utilisé : son icône clignote dans sa couleur. */
    flash(toolName, ms = 3500) {
      const fam = toolFamily(toolName);
      const it = items.find((x) => x.id === fam);
      if (!it) return;
      const now = performance.now();
      if (now > it.flashUntil) it.flashStart = now;
      it.flashUntil = now + ms;
      visibleUntil = Math.max(visibleUntil, now + ms + 1500);
    },
    /** Position MONDE de l'icône d'un outil (départ des cartes de sources), ou null. */
    iconWorldPos(toolName) {
      const it = items.find((x) => x.id === toolFamily(toolName));
      return it && group.visible ? it.holder.getWorldPosition(new THREE.Vector3()) : null;
    },
    update(center, radius, now, dt = 0.016) {
      const want = now < visibleUntil;
      fade += (want ? 1 : -1) * dt * 2.2;
      fade = Math.max(0, Math.min(1, fade));
      group.visible = fade > 0.01;
      if (!group.visible) return;
      // À la BASE de l'orbe (sous son équateur) : l'orbe reste bien visible.
      group.position.copy(parent.worldToLocal(center.clone().add(new THREE.Vector3(0, -radius * 0.95, 0))));
      spin += dt * 0.35;
      const n = items.length;
      const rad = radius * 0.8 + 0.1;
      const size = 0.056;
      items.forEach((it, i) => {
        const a = spin + (i / n) * Math.PI * 2;
        // Ceinture légèrement inclinée, comme un anneau autour d'une planète.
        // Anneau à plat, avec une très légère ondulation.
        it.holder.position.set(Math.cos(a) * rad, Math.sin(a * 2 + spin) * 0.006, Math.sin(a) * rad);
        it.holder.rotation.set(0, -a + Math.PI / 2, 0); // face tournée vers l'extérieur
        const flashing = now < it.flashUntil;
        const k = flashing ? 0.5 + 0.5 * Math.sin((now - it.flashStart) / 1000 * Math.PI * 4) : 0;
        it.material.emissiveIntensity = flashing ? 0.5 + k * 1.1 : Math.max(0, it.material.emissiveIntensity - dt * 3);
        it.material.color.setHex(flashing ? 0xffffff : 0xffffff);
        it.material.opacity = (flashing ? 0.95 : 0.72) * fade;
        for(const surface of it.surfaces){surface.material.transparent=true;surface.material.opacity=surface.opacity*fade;surface.material.emissiveIntensity=surface.emission+(flashing ? .3+k*.5 : 0);}
        const s = size * (flashing ? 1.25 + k * 0.12 : 1) * (0.6 + 0.4 * fade);
        it.mesh.scale.setScalar(s);
      });
    },
  };
}
