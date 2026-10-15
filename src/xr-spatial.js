// Lumen XR — ancrage dans la pièce.
//
// Trois services WebXR, tous optionnels (le casque les accorde ou non) :
//
//   • ANCRES (feature « anchors ») : l'orbe et chaque panneau posés reçoivent
//     une ancre. Sur Quest, l'ancre peut être rendue PERSISTANTE
//     (`requestPersistentHandle`) : son UUID est gardé dans localStorage et
//     restauré à la session suivante (`restorePersistentAnchor`) — Lumen
//     réapparaît exactement là où on l'avait laissé.
//   • PLANS (feature « plane-detection ») : tables, sols, murs de la pièce
//     scannée. On y « aimante » l'orbe (posée sur la table) et les panneaux
//     (plaqués au mur), et l'ombre de l'orbe se projette sur la surface.
//   • HIT-TEST (feature « hit-test ») : point réel visé par le regard, pour
//     placer la fiche « Regarde » à côté de l'objet observé.
//
// Sans ces services (aperçu, navigateur sans le support), tout se replie : pas
// d'aimantation, ombre sur le sol (y = 0 en local-floor), pas de persistance
// d'ancre — la disposition, elle, reste mémorisée par xr.js.

import * as THREE from "/lib/three.module.js";

const LS_KEY = "xrAnchors"; // { clé d'objet: uuid persistant }

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

export class Spatial {
  constructor(renderer) {
    this.renderer = renderer;
    this.session = null;
    this.anchors = new Map();   // clé → { anchor, obj, uuid }
    this.pending = [];          // créations d'ancre à faire dans la prochaine frame
    this.planes = [];           // [{ orientation, matrix, inv, minX, maxX, minZ, maxZ }]
    this.hitSource = null;
    this.lastHit = null;        // Vector3 du point visé (monde)
    this.features = new Set();
    this.enabled = localStorage.getItem("xrAnchorsOn") !== "off";
  }

  /// Au démarrage de session : services accordés, source de hit-test,
  /// restauration des ancres persistantes.
  async start(session, objects) {
    this.session = session;
    this.features = new Set(session.enabledFeatures || []);
    this.planes = [];
    this.anchors.clear();
    this.pending = [];
    if (this.features.has("hit-test") && session.requestHitTestSource) {
      try {
        const viewer = await session.requestReferenceSpace("viewer");
        this.hitSource = await session.requestHitTestSource({ space: viewer });
      } catch { this.hitSource = null; }
    }
    if (this.enabled && this.canPersist) {
      const saved = this.saved();
      for (const [key, uuid] of Object.entries(saved)) {
        const obj = objects[key];
        if (!obj) continue;
        try {
          const anchor = await session.restorePersistentAnchor(uuid);
          this.anchors.set(key, { anchor, obj, uuid });
        } catch {
          // Ancre perdue (pièce différente, espace réinitialisé) : on l'oublie.
          delete saved[key];
          this.save(saved);
        }
      }
    }
  }

  stop() {
    this.session = null;
    this.hitSource = null;
    this.anchors.clear();
    this.pending = [];
    this.planes = [];
    this.lastHit = null;
  }

  get hasAnchors() { return !!this.session && this.features.has("anchors"); }
  get canPersist() { return this.hasAnchors && typeof this.session.restorePersistentAnchor === "function"; }
  get hasPlanes() { return this.planes.length > 0; }
  anchored(key) { return this.anchors.has(key); }

  saved() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; } catch { return {}; }
  }
  save(map) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(map)); } catch {}
  }

  /// Pose (ou repose) une ancre sur l'objet, à sa position monde actuelle.
  /// Appelé au lâcher d'une saisie ; la création a lieu dans la frame suivante.
  anchor(key, obj) {
    if (!this.enabled || !this.hasAnchors) return;
    this.pending = this.pending.filter((p) => p.key !== key);
    this.pending.push({ key, obj });
  }

  /// Retire l'ancre d'un objet (on le déplace : il suit la main, plus l'ancre).
  release(key) {
    const a = this.anchors.get(key);
    if (!a) return;
    this.anchors.delete(key);
    try { a.anchor.delete?.(); } catch {}
    if (a.uuid && this.session?.deletePersistentAnchor) {
      this.session.deletePersistentAnchor(a.uuid).catch(() => {});
      const saved = this.saved();
      delete saved[key];
      this.save(saved);
    }
  }

  /// Oublie tout (bouton « Recentrer » ou réglage) : ancres et UUID.
  clearAll() {
    for (const key of [...this.anchors.keys()]) this.release(key);
    const saved = this.saved();
    if (this.session?.deletePersistentAnchor) {
      for (const uuid of Object.values(saved)) this.session.deletePersistentAnchor(uuid).catch(() => {});
    }
    this.save({});
  }

  /// Chaque frame : créations en attente, poses des ancres, plans, hit-test.
  update(frame, refSpace) {
    if (!frame || !refSpace) return;

    // 1) Créations d'ancre (doivent se faire avec une XRFrame active).
    if (this.pending.length && frame.createAnchor) {
      for (const { key, obj } of this.pending.splice(0)) {
        this.release(key);
        obj.updateMatrixWorld(true);
        obj.matrixWorld.decompose(_p, _q, _s);
        const pose = new XRRigidTransform({ x: _p.x, y: _p.y, z: _p.z }, { x: _q.x, y: _q.y, z: _q.z, w: _q.w });
        frame.createAnchor(pose, refSpace).then(async (anchor) => {
          const entry = { anchor, obj, uuid: null };
          this.anchors.set(key, entry);
          if (anchor.requestPersistentHandle) {
            try {
              entry.uuid = await anchor.requestPersistentHandle();
              const saved = this.saved();
              saved[key] = entry.uuid;
              this.save(saved);
            } catch {}
          }
        }).catch(() => {});
      }
    }

    // 2) L'ancre dicte la pose monde de l'objet (le suivi du casque la corrige
    //    en continu : c'est ce qui la garde « collée » à la pièce).
    for (const { anchor, obj } of this.anchors.values()) {
      const pose = frame.getPose(anchor.anchorSpace, refSpace);
      if (!pose) continue;
      const t = pose.transform;
      _p.set(t.position.x, t.position.y, t.position.z);
      _q.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
      setWorldPose(obj, _p, _q);
    }

    // 3) Plans détectés (l'ensemble change rarement, mais les poses bougent).
    if (frame.detectedPlanes) {
      const list = [];
      frame.detectedPlanes.forEach((plane) => {
        const pose = frame.getPose(plane.planeSpace, refSpace);
        if (!pose || !plane.polygon?.length) return;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const v of plane.polygon) {
          minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
          minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
        }
        const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
        list.push({ orientation: plane.orientation, matrix, inv: matrix.clone().invert(), minX, maxX, minZ, maxZ,
          polygon: plane.polygon.map((v) => [v.x, v.z]), label: plane.semanticLabel || "" });
      });
      const changed = list.length !== this.planes.length;
      this.planes = list;
      if (changed) { this.onPlanesChanged?.(this.counts()); this.rebuildOverlay(); }
      else if (this.overlay?.visible) this.updateOverlayPoses();
    }

    // 4) Point réel visé par le regard.
    if (this.hitSource) {
      const hits = frame.getHitTestResults(this.hitSource);
      const pose = hits[0]?.getPose(refSpace);
      this.lastHit = pose ? new THREE.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z) : null;
    }
  }

  // ---- Scan de la pièce ---------------------------------------------------
  //
  // Sur Quest, les plans ne sont connus que si la pièce a été scannée
  // (Configuration de l'espace). `initiateRoomCapture()` lance ce scan depuis
  // la session : sans lui, Lumen XR entrait dans la pièce « à l'aveugle ».

  get canCapture() { return typeof this.session?.initiateRoomCapture === "function"; }

  async captureRoom() {
    if (!this.canCapture) return false;
    try { await this.session.initiateRoomCapture(); return true; } catch { return false; }
  }

  /// Empreinte de la pièce scannée : dimensions arrondies (50 cm) des murs et
  /// des surfaces. Deux pièces différentes ont des empreintes différentes ;
  /// la même pièce garde la sienne d'une session à l'autre. "" sans scan.
  roomKey() {
    if (!this.planes.length) return "";
    const size = (p) => Math.round(Math.max(p.maxX - p.minX, p.maxZ - p.minZ) * 2) / 2;
    const walls = this.planes.filter((p) => p.orientation === "vertical").map(size).sort((a, b) => a - b);
    const flats = this.planes.filter((p) => p.orientation !== "vertical").map(size).sort((a, b) => a - b);
    return `m${walls.join(",")}|s${flats.join(",")}`;
  }

  counts() {
    let walls = 0, surfaces = 0;
    for (const p of this.planes) {
      if (p.orientation === "vertical") walls++;
      else surfaces++;
    }
    return { walls, surfaces };
  }

  // ---- Contour des plans (visible pendant qu'on déplace un panneau) --------

  attachOverlay(scene) {
    this.overlay = new THREE.Group();
    this.overlay.visible = false;
    this.overlay.renderOrder = 1;
    scene.add(this.overlay);
  }

  showPlanes(on) {
    if (!this.overlay) return;
    this.overlay.visible = on && this.planes.length > 0;
    if (this.overlay.visible) this.updateOverlayPoses();
  }

  rebuildOverlay() {
    if (!this.overlay) return;
    for (const c of [...this.overlay.children]) { c.geometry?.dispose(); c.material?.dispose(); this.overlay.remove(c); }
    for (const pl of this.planes) {
      const pts = pl.polygon.map(([x, z]) => new THREE.Vector3(x, 0.005, z));
      if (pts.length < 3) continue;
      const wall = pl.orientation === "vertical";
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: wall ? 0x9961ff : 0x46d6a0, transparent: true, opacity: 0.85, depthTest: false }),
      );
      line.matrixAutoUpdate = false;
      line.userData.plane = pl;
      this.overlay.add(line);
    }
    this.updateOverlayPoses();
  }

  updateOverlayPoses() {
    if (!this.overlay) return;
    const byIndex = this.overlay.children;
    byIndex.forEach((line, i) => {
      const pl = this.planes[i] && this.planes[i].polygon.length >= 3 ? this.planes[i] : line.userData.plane;
      line.matrix.copy(pl.matrix);
      line.matrixWorldNeedsUpdate = true;
    });
  }

  /// Mur touché par un rayon (monde). Renvoie { point, normal } ou null.
  raycastWall(origin, dir, maxDist = 6) {
    let best = null;
    for (const pl of this.planes) {
      if (pl.orientation !== "vertical") continue;
      const o = origin.clone().applyMatrix4(pl.inv);
      const d = dir.clone().transformDirection(pl.inv);
      if (Math.abs(d.y) < 1e-4) continue;
      const t = -o.y / d.y;
      if (t <= 0 || t > maxDist) continue;
      const lx = o.x + d.x * t, lz = o.z + d.z * t;
      if (lx < pl.minX || lx > pl.maxX || lz < pl.minZ || lz > pl.maxZ) continue;
      if (!best || t < best.t) best = { t, pl, lx, lz };
    }
    if (!best) return null;
    const point = new THREE.Vector3(best.lx, 0.02, best.lz).applyMatrix4(best.pl.matrix);
    const normal = new THREE.Vector3(0, 1, 0).transformDirection(best.pl.matrix);
    // La normale doit regarder vers l'utilisateur.
    if (normal.dot(dir) > 0) normal.negate();
    return { point, normal };
  }

  /// Plan (repère local : Y = normale) contenant la projection du point, à
  /// moins de `maxDist` au-dessus/devant. Renvoie { plane, local, dist }.
  nearestPlane(worldPoint, orientation, maxDist) {
    let best = null;
    for (const pl of this.planes) {
      if (pl.orientation !== orientation) continue;
      const local = worldPoint.clone().applyMatrix4(pl.inv);
      if (local.x < pl.minX || local.x > pl.maxX || local.z < pl.minZ || local.z > pl.maxZ) continue;
      const dist = local.y; // > 0 : du côté de la normale (au-dessus / devant)
      if (dist < -0.05 || dist > maxDist) continue;
      if (!best || Math.abs(dist) < Math.abs(best.dist)) best = { plane: pl, local, dist };
    }
    return best;
  }

  /// Aimante l'orbe sur une table juste en dessous : elle s'y pose, flottant à
  /// peine. Renvoie vrai si elle a été posée.
  snapOrb(obj, radius) {
    if (!this.planes.length) return false;
    obj.updateMatrixWorld(true);
    const wp = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
    const bottom = wp.clone().setY(wp.y - radius);
    const hit = this.nearestPlane(bottom, "horizontal", 0.25);
    if (!hit) return false;
    const surfaceY = new THREE.Vector3(hit.local.x, 0, hit.local.z).applyMatrix4(hit.plane.matrix).y;
    wp.y = surfaceY + radius + 0.02;
    setWorldPosition(obj, wp);
    return true;
  }

  /// Plaque un panneau sur le mur VISÉ par le rayon (même à plusieurs
  /// mètres), sinon contre un mur proche. Vrai si fait.
  snapPanel(obj, ray = null) {
    if (!this.planes.length) return false;
    // Pose commune : normale tournée VERS l'utilisateur (le plan du casque peut
    // la donner dans l'autre sens -> panneau à l'envers dans le mur), panneau
    // gardé vertical, décollé de 6 cm : à 0-2 cm, l'occlusion par la profondeur
    // le coupait en deux et le faisait clignoter (z-fighting avec le mur réel).
    const place = (point, normal, viewer) => {
      const n = normal.clone(); n.y = 0;
      if (n.lengthSq() < 1e-4) return false;
      n.normalize();
      if (viewer && n.dot(viewer.clone().sub(point)) < 0) n.negate();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      setWorldPose(obj, point.clone().addScaledVector(n, 0.06), q);
      return true;
    };
    if (ray) {
      const hit = this.raycastWall(ray.origin, ray.dir);
      if (hit && place(hit.point, hit.normal, ray.origin)) return true;
    }
    obj.updateMatrixWorld(true);
    const wp = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
    const hit = this.nearestPlane(wp, "vertical", 0.3);
    if (!hit) return false;
    const onPlane = new THREE.Vector3(hit.local.x, 0, hit.local.z).applyMatrix4(hit.plane.matrix);
    const normal = new THREE.Vector3(0, 1, 0).transformDirection(hit.plane.matrix);
    return place(onPlane, normal, ray?.origin || wp);
  }

  /// Hauteur de la surface sous un point (table détectée, sinon le sol).
  surfaceBelow(worldPoint) {
    let y = 0;
    for (const pl of this.planes) {
      if (pl.orientation !== "horizontal") continue;
      const local = worldPoint.clone().applyMatrix4(pl.inv);
      if (local.y < 0 || local.x < pl.minX || local.x > pl.maxX || local.z < pl.minZ || local.z > pl.maxZ) continue;
      const sy = worldPoint.y - local.y;
      if (sy > y && sy < worldPoint.y) y = sy;
    }
    return y;
  }
}

/// Place un objet (enfant d'un groupe quelconque) à une position/rotation MONDE.
export function setWorldPose(obj, pos, quat) {
  const parent = obj.parent;
  if (!parent) { obj.position.copy(pos); obj.quaternion.copy(quat); return; }
  parent.updateMatrixWorld(true);
  _inv.copy(parent.matrixWorld).invert();
  _m.compose(pos, quat, _s.set(1, 1, 1)).premultiply(_inv);
  const scale = obj.scale.clone();
  _m.decompose(obj.position, obj.quaternion, _s);
  obj.scale.copy(scale);
}

export function setWorldPosition(obj, pos) {
  const parent = obj.parent;
  obj.position.copy(parent ? parent.worldToLocal(pos.clone()) : pos);
}
