// Robot Heads by Fayaz Ahmed — MIT; see LICENSE. Ported to JavaScript for Lumen.
const HEAD = {
  /* radius of the rolled edge round the front and the back */
  bevel: 0.075,
  /* the shell's rim round the screen, then the rubber gasket */
  margin: 0.045,
  gasket: 0.022,
  /* how far the glass sits behind the face */
  recess: 0.03,
  earY: 0.03,
  /* the antenna: the stem's length and the ball's radius */
  stem: 0.2,
  ball: 0.052
};
const INSET = {
  plate: HEAD.bevel,
  hole: HEAD.bevel + HEAD.margin,
  glass: HEAD.bevel + HEAD.margin + HEAD.gasket
};
function rotation(yaw, pitch, roll) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const a = [cy, sy * sp, sy * cp, 0, cp, -sp, -sy, cy * sp, cy * cp];
  return [
    cr * a[0] - sr * a[3],
    cr * a[1] - sr * a[4],
    cr * a[2] - sr * a[5],
    sr * a[0] + cr * a[3],
    sr * a[1] + cr * a[4],
    sr * a[2] + cr * a[5],
    a[6],
    a[7],
    a[8]
  ];
}
function rotate(m, x, y, z) {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}
const norm = (x, y, z) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};
const TAU = Math.PI * 2;
function makeShape(name, centres, r, depth, screwAt, backScrewAt) {
  const pts = centres.map(([x, y]) => ({ x, y, t: Math.atan2(y, x) })).sort((a, b) => a.t - b.t);
  const n = pts.length;
  const edge = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    edge.push(Math.atan2(-(b.x - a.x), b.y - a.y));
  }
  const corners = pts.map((p, i) => {
    if (n === 1) return { x: p.x, y: p.y, a0: -Math.PI, a1: Math.PI };
    let a0 = edge[(i - 1 + n) % n];
    let a1 = edge[i];
    while (a1 < a0) a1 += TAU;
    return { x: p.x, y: p.y, a0, a1 };
  });
  const sdPoly = (x, y) => {
    if (n === 1) return Math.hypot(x - pts[0].x, y - pts[0].y);
    let d = Infinity;
    let inside = true;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const ex = b.x - a.x, ey = b.y - a.y;
      const px = x - a.x, py = y - a.y;
      const t = Math.max(0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey)));
      d = Math.min(d, Math.hypot(px - ex * t, py - ey * t));
      if (ex * py - ey * px < 0) inside = false;
    }
    return inside ? -d : d;
  };
  const sd = (x, y, inset) => sdPoly(x, y) - (r - inset);
  const path = (ctx, inset) => {
    const rr = Math.max(5e-4, r - inset);
    corners.forEach((c, i) => {
      if (i === 0) ctx.moveTo(c.x + rr * Math.cos(c.a0), c.y + rr * Math.sin(c.a0));
      ctx.arc(c.x, c.y, rr, c.a0, c.a1);
    });
    ctx.closePath();
  };
  let hx = 0, hy = 0;
  for (const p of pts) {
    hx = Math.max(hx, Math.abs(p.x) + r);
    hy = Math.max(hy, Math.abs(p.y) + r);
  }
  let lo = 0, hi = hx + 0.1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sd(mid, HEAD.earY, 0) < 0) lo = mid;
    else hi = mid;
  }
  const place = (dirs, inward) => dirs.map((d, i) => {
    const a = d * Math.PI / 180;
    const c = corners.find((k) => [a, a + TAU, a - TAU].some((x) => x >= k.a0 - 1e-6 && x <= k.a1 + 1e-6)) ?? corners[0];
    return [c.x + Math.cos(a) * (r - inward), c.y + Math.sin(a) * (r - inward), 0.5 + i * 0.9];
  });
  const gw = 2 * (hx - INSET.glass), gh = 2 * (hy - INSET.glass);
  const pitch = Math.min(FACE_SHARE * gw / 14, 0.65 * gh / 10);
  return {
    name,
    r,
    depth,
    corners,
    hx,
    hy,
    pitch,
    earX: lo - 8e-3,
    /* on the face: halfway between the lip round the hole and the rolled edge */
    screws: place(screwAt, (INSET.hole - 0.018 + INSET.plate) / 2),
    /* on the back: inside the panel line */
    backScrews: place(backScrewAt, INSET.plate + 0.07),
    sd,
    path
  };
}
const hexCentres = (a) => [0, 60, 120, 180, 240, 300].map((d) => [a * Math.cos(d * Math.PI / 180), a * Math.sin(d * Math.PI / 180)]);
const FACE_SHARE = 0.6;
const CORNERS = [45, 135];
const BACK_CORNERS = [-135, -45, 45, 135];
const SHAPES = {
  rectangle: () => makeShape("rectangle", [[-0.29, -0.17], [0.29, -0.17], [0.29, 0.17], [-0.29, 0.17]], 0.21, 0.6, CORNERS, BACK_CORNERS),
  square: () => makeShape("square", [[-0.22, -0.22], [0.22, -0.22], [0.22, 0.22], [-0.22, 0.22]], 0.2, 0.6, CORNERS, BACK_CORNERS),
  circle: () => makeShape("circle", [[0, 0]], 0.46, 0.56, CORNERS, BACK_CORNERS),
  hexagon: () => makeShape("hexagon", hexCentres(0.35), 0.16, 0.58, [60, 120], [-120, -60, 60, 120])
};
const shapeCache = /* @__PURE__ */ new Map();
function getShape(name) {
  let s = shapeCache.get(name);
  if (!s) {
    s = (SHAPES[name] ?? SHAPES.rectangle)();
    shapeCache.set(name, s);
  }
  return s;
}
function finish(pos, quads, vn) {
  const normals = new Float32Array(quads.length / 4 * 3);
  for (let q = 0; q < quads.length / 4; q++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const i = quads[q * 4 + k] * 3;
      x += vn[i];
      y += vn[i + 1];
      z += vn[i + 2];
    }
    normals.set(norm(x, y, z), q * 3);
  }
  return { pos: new Float32Array(pos), quads: new Uint16Array(quads), normals };
}
function stitch(rings, samples, closed = true) {
  const quads = [];
  const span = closed ? samples : samples - 1;
  for (let k = 0; k < rings - 1; k++) {
    for (let j = 0; j < span; j++) {
      const j2 = (j + 1) % samples;
      quads.push(k * samples + j, k * samples + j2, (k + 1) * samples + j2, (k + 1) * samples + j);
    }
  }
  return quads;
}
function buildBody(shape, bevelSteps = 10) {
  const R = shape.r, b = HEAD.bevel, zf = shape.depth / 2;
  const outline = [];
  for (const c of shape.corners) {
    const sweep = c.a1 - c.a0;
    const steps = Math.max(2, Math.ceil(sweep / (Math.PI / 2) * 14));
    const last = sweep >= TAU - 1e-6 ? steps - 1 : steps;
    for (let i = 0; i <= last; i++) {
      const a = c.a0 + i / steps * sweep;
      outline.push([c.x, c.y, Math.cos(a), Math.sin(a)]);
    }
  }
  const profile = [];
  for (let i = bevelSteps; i >= 0; i--) {
    const t = i / bevelSteps * (Math.PI / 2);
    profile.push([-zf + b - b * Math.sin(t), b * (1 - Math.cos(t)), -t]);
  }
  for (let i = 0; i <= bevelSteps; i++) {
    const t = i / bevelSteps * (Math.PI / 2);
    profile.push([zf - b + b * Math.sin(t), b * (1 - Math.cos(t)), t]);
  }
  const pos = [], vn = [];
  for (const [z, inset, t] of profile) {
    for (const [cx, cy, nx, ny] of outline) {
      pos.push(cx + (R - inset) * nx, cy + (R - inset) * ny, z);
      vn.push(nx * Math.cos(t), ny * Math.cos(t), Math.sin(t));
    }
  }
  return finish(pos, stitch(profile.length, outline.length), vn);
}
function buildLathe(profile, origin, axis, segments = 36) {
  const e1 = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e2 = norm(axis[1] * e1[2] - axis[2] * e1[1], axis[2] * e1[0] - axis[0] * e1[2], axis[0] * e1[1] - axis[1] * e1[0]);
  const pos = [], vn = [];
  for (let k = 0; k < profile.length; k++) {
    const [r, t] = profile[k];
    const prev = profile[Math.max(0, k - 1)], next = profile[Math.min(profile.length - 1, k + 1)];
    const dr = next[0] - prev[0], dt = next[1] - prev[1];
    const l = Math.hypot(dr, dt) || 1;
    const nr = dt / l, na = -dr / l;
    for (let j = 0; j < segments; j++) {
      const a = j / segments * TAU;
      const rx = Math.cos(a) * e1[0] + Math.sin(a) * e2[0];
      const ry = Math.cos(a) * e1[1] + Math.sin(a) * e2[1];
      const rz = Math.cos(a) * e1[2] + Math.sin(a) * e2[2];
      pos.push(origin[0] + axis[0] * t + r * rx, origin[1] + axis[1] * t + r * ry, origin[2] + axis[2] * t + r * rz);
      vn.push(rx * nr + axis[0] * na, ry * nr + axis[1] * na, rz * nr + axis[2] * na);
    }
  }
  return finish(pos, stitch(profile.length, segments), vn);
}
const EAR_PROFILE = [
  [0.06, -0.012],
  [0.068, 0],
  [0.074, 6e-3],
  [0.08, 0.018],
  [0.084, 0.032],
  [0.084, 0.048],
  [0.079, 0.06],
  [0.068, 0.07],
  [0.052, 0.077],
  [0.032, 0.081],
  [0.014, 0.083],
  [0, 0.0835]
];
const COLLAR_PROFILE = [
  [0.05, -0.012],
  [0.052, 6e-3],
  [0.05, 0.016],
  [0.042, 0.024],
  [0.026, 0.029],
  [0.014, 0.031],
  [0, 0.032]
];
const meshCache = /* @__PURE__ */ new Map();
function headMeshes(shape) {
  let m = meshCache.get(shape.name);
  if (!m) {
    m = {
      body: buildBody(shape),
      earL: buildLathe(EAR_PROFILE, [-shape.earX, HEAD.earY, 0], [-1, 0, 0]),
      earR: buildLathe(EAR_PROFILE, [shape.earX, HEAD.earY, 0], [1, 0, 0]),
      collar: buildLathe(COLLAR_PROFILE, [0, -shape.hy, 0], [0, -1, 0], 16)
    };
    meshCache.set(shape.name, m);
  }
  return m;
}
export {
  HEAD,
  INSET,
  buildBody,
  buildLathe,
  getShape,
  headMeshes,
  rotate,
  rotation
};
