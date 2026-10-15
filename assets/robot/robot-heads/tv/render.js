// Robot Heads by Fayaz Ahmed — MIT; see LICENSE. Ported to JavaScript for Lumen.
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { COLS, FACES, LIGHTS, ROWS, makeGrid } from "./faces.js";
import { HEAD, INSET, headMeshes, rotate, rotation } from "./geometry.js";
import { KEY, css, radiance, shadeCss } from "./light.js";
const makeCanvas = (w, h) => {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
};
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hash = (x, y) => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
};
const HALF = (() => {
  const l = Math.hypot(KEY[0], KEY[1], KEY[2] + 1);
  return [KEY[0] / l, KEY[1] / l, (KEY[2] + 1) / l];
})();
const HEAD_TRAVEL = { antenna: 0.028 + HEAD.stem + HEAD.ball * 1.8, knob: 0.035, ear: 0.105, glow: 0.18, hop: 0.3, overshoot: 0.13, shadow: 0.22, side: 0.12 };
const BOX_INSET = 0.05;
function frameFor(shape, antenna, box) {
  const top = antenna ? HEAD_TRAVEL.antenna : HEAD_TRAVEL.knob;
  const tall = 2 * shape.hy + top;
  const wide = 2 * (shape.earX + HEAD_TRAVEL.ear);
  const inner = box * (1 - 2 * BOX_INSET);
  const unit = Math.min(inner / tall, inner / wide);
  const above = (box - tall * unit) / 2;
  const centreY = above + (shape.hy + top) * unit;
  const reachUp = (antenna ? HEAD_TRAVEL.glow + HEAD_TRAVEL.hop : HEAD_TRAVEL.hop + HEAD_TRAVEL.overshoot) * unit;
  const reachDown = centreY + (shape.hy + HEAD_TRAVEL.shadow) * unit;
  const reachSide = box / 2 + (shape.earX + HEAD_TRAVEL.ear + HEAD_TRAVEL.side) * unit;
  const padTop = Math.ceil(Math.max(0, reachUp - above) + 1);
  const padBottom = Math.ceil(Math.max(0, reachDown - box) + 1);
  const padSide = Math.ceil(Math.max(0, reachSide - box) + 1);
  return { box, padTop, padBottom, padSide, unit, cx: padSide + box / 2, cy: padTop + centreY };
}
const SCREEN_OVER = 0.035;
const glassOf = (s) => ({ hx: s.hx - INSET.glass, hy: s.hy - INSET.glass });
function screenOf(s) {
  const g = glassOf(s);
  return {
    hx: Math.max(g.hx, COLS / 2 * s.pitch) + SCREEN_OVER,
    hy: Math.max(g.hy, ROWS / 2 * s.pitch) + SCREEN_OVER
  };
}
const plateOf = (s) => ({ hx: s.hx - INSET.plate, hy: s.hy - INSET.plate });
function bakeRelief(shape, unit, fn) {
  const PLATE = plateOf(shape);
  const w = Math.ceil(PLATE.hx * 2 * unit), h = Math.ceil(PLATE.hy * 2 * unit);
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(c.width, c.height);
  const d = img.data;
  const px = PLATE.hx * 2 / c.width;
  for (let iy = 0; iy < c.height; iy++) {
    const v = -PLATE.hy + (iy + 0.5) * px;
    for (let ix = 0; ix < c.width; ix++) {
      const u = -PLATE.hx + (ix + 0.5) * px;
      const edge = shape.sd(u, v, INSET.plate);
      const cover = Math.min(1, Math.max(0, 0.5 - edge / px));
      if (cover <= 0) continue;
      const val = fn(u, v, px, ix, iy);
      const i = (iy * c.width + ix) * 4;
      const a = Math.min(1, Math.abs(val)) * cover;
      const white = val > 0 ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = white;
      d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function tilt(nx, ny, nz, gloss = 0.55, power = 36) {
  const l = Math.hypot(nx, ny, nz);
  nx /= l;
  ny /= l;
  nz /= l;
  const diff = (nx * KEY[0] + ny * KEY[1] + nz * KEY[2] - KEY[2]) * 0.95;
  const spec = gloss * Math.pow(Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]), power);
  return diff + spec - gloss * Math.pow(HALF[2], power);
}
function grad(fn, u, v) {
  const e = 15e-4;
  const gx = fn(u + e, v) - fn(u - e, v);
  const gy = fn(u, v + e) - fn(u, v - e);
  const l = Math.hypot(gx, gy) || 1;
  return [gx / l, gy / l];
}
function screw(u, v, cx, cy, angle) {
  const rs = 0.013;
  const dx = u - cx, dy = v - cy;
  const d = Math.hypot(dx, dy);
  if (d > rs + 6e-3) return null;
  if (d > rs) return -0.5 * (1 - (d - rs) / 6e-3);
  const nz = Math.sqrt(Math.max(0, 1 - (d / rs) ** 2)) + 0.6;
  let val = tilt(dx / rs, dy / rs, nz, 0.9, 30) * 1.3 + 0.08;
  const c = Math.cos(angle), s = Math.sin(angle);
  const across = Math.abs(dx * -s + dy * c);
  if (across < 26e-4 && d < rs * 0.8) val = -0.65;
  return val;
}
function bakeFront(shape, unit) {
  const LIP = 0.018;
  const sdHole = (u, v) => shape.sd(u, v, INSET.hole);
  const sdGlass = (u, v) => shape.sd(u, v, INSET.glass);
  const screws = shape.screws;
  return bakeRelief(shape, unit, (u, v, _px, ix, iy) => {
    const grain = (hash(ix, iy) - 0.5) * 0.07;
    for (const [cx, cy, a] of screws) {
      const s = screw(u, v, cx, cy, a);
      if (s !== null) return s;
    }
    const dh = sdHole(u, v);
    if (dh >= 0) {
      if (dh < LIP) {
        const [gx, gy] = grad(sdHole, u, v);
        const s = 1 - dh / LIP;
        const th = s * s * 1.25;
        return tilt(-gx * Math.sin(th), -gy * Math.sin(th), Math.cos(th)) + grain;
      }
      return grain;
    }
    const dg = sdGlass(u, v);
    if (dg >= 0) {
      const s = dg / HEAD.gasket;
      const [gx, gy] = grad(sdGlass, u, v);
      const th = (s - 0.45) * 2.2;
      return tilt(gx * Math.sin(th), gy * Math.sin(th), Math.cos(th), 0.22, 14) * 0.7 + grain * 0.4;
    }
    const k = 0.05;
    const blocked = smooth(-0.012, 0.012, sdGlass(u - KEY[0] * k, v - KEY[1] * k));
    return -(0.5 * blocked + 0.32 * Math.exp(dg / 0.014));
  });
}
function bakeBack(shape, unit) {
  const vents = [-0.12, -0.065, -0.01, 0.045, 0.1];
  const panel = (u, v) => shape.sd(u, v, INSET.plate + 0.04);
  const screws = shape.backScrews;
  return bakeRelief(shape, unit, (u, v, _px, ix, iy) => {
    const grain = (hash(ix, iy) - 0.5) * 0.07;
    for (const [cx, cy, a] of screws) {
      const s = screw(u, v, cx, cy, a);
      if (s !== null) return s;
    }
    const dp = panel(u, v);
    if (Math.abs(dp) < 6e-3) {
      const [gx, gy] = grad(panel, u, v);
      const th = dp / 6e-3 * 1.1;
      return tilt(-gx * Math.sin(th), -gy * Math.sin(th), Math.cos(th)) * 0.9 - 0.18;
    }
    for (const vy of vents) {
      const slot = (a, b) => Math.hypot(Math.max(0, Math.abs(a) - 0.196), b - vy) - 0.014;
      const d = slot(u, v);
      if (d < 0) {
        return -0.72 - 0.15 * smooth(-0.014, 0, -(v - vy));
      }
      if (d < 0.01) {
        const [gx, gy] = grad(slot, u, v);
        const th = (1 - d / 0.01) ** 2 * 1.2;
        return tilt(-gx * Math.sin(th), -gy * Math.sin(th), Math.cos(th)) + grain;
      }
    }
    return grain;
  });
}
function bakeScreenBase(w, h, pitch, x0, y0, led) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.65);
  g.addColorStop(0, "#111417");
  g.addColorStop(1, "#050607");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const cell = pitch * 0.8;
  const off = (pitch - cell) / 2;
  const lens = `rgba(${Math.round(60 + led[0] * 0.12)},${Math.round(64 + led[1] * 0.12)},${Math.round(70 + led[2] * 0.12)},0.34)`;
  const c0 = -Math.ceil(x0 / pitch), c1 = Math.ceil((w - x0) / pitch);
  const r0 = -Math.ceil(y0 / pitch), r1 = Math.ceil((h - y0) / pitch);
  ctx.fillStyle = lens;
  for (let r = r0; r < r1; r++) for (let q = c0; q < c1; q++) ctx.fillRect(x0 + q * pitch + off, y0 + r * pitch + off, cell, cell);
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  for (let r = r0; r < r1; r++) for (let q = c0; q < c1; q++) ctx.fillRect(x0 + q * pitch + off, y0 + r * pitch + off, cell, Math.max(1, cell * 0.16));
  return c;
}
function bakeGlass(w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.55);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.5)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
  const top = ctx.createLinearGradient(0, 0, 0, h);
  top.addColorStop(0, "rgba(190,210,255,0.09)");
  top.addColorStop(0.42, "rgba(190,210,255,0.015)");
  top.addColorStop(0.43, "rgba(190,210,255,0)");
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w * 0.3, h * 0.2);
  ctx.scale(1, 0.45);
  const spot = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.35);
  spot.addColorStop(0, "rgba(255,255,255,0.07)");
  spot.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = spot;
  ctx.fillRect(-w, -h * 3, w * 2, h * 6);
  ctx.restore();
  return c;
}
function grainPattern(ctx) {
  const c = makeCanvas(128, 128);
  const g = c.getContext("2d");
  const img = g.createImageData(128, 128);
  for (let i = 0; i < 128 * 128; i++) {
    const r = hash(i, 7);
    const on = r > 0.5 ? 255 : 0;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = on;
    img.data[i * 4 + 3] = Math.round(hash(i, 13) * 9);
  }
  g.putImageData(img, 0, 0);
  return ctx.createPattern(c, "repeat");
}
const bakes = /* @__PURE__ */ new Map();
function bakesFor(shape, unit) {
  const key = `${shape.name}:${Math.round(unit)}`;
  let b = bakes.get(key);
  if (!b) {
    const sc = screenOf(shape);
    b = { front: bakeFront(shape, unit), back: bakeBack(shape, unit), glass: bakeGlass(sc.hx * 2 * unit, sc.hy * 2 * unit) };
    bakes.set(key, b);
  }
  return b;
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
class RobotRenderer {
  constructor() {
    __publicField(this, "shape", null);
    __publicField(this, "meshes", null);
    __publicField(this, "unit", 0);
    __publicField(this, "ledKey", "");
    __publicField(this, "front", null);
    __publicField(this, "back", null);
    __publicField(this, "screen", null);
    __publicField(this, "screenBase", null);
    __publicField(this, "glass", null);
    __publicField(this, "layer", null);
    __publicField(this, "tiny", makeCanvas(COLS, ROWS));
    __publicField(this, "tinyHalf", makeCanvas(COLS / 2, ROWS / 2));
    __publicField(this, "tinyImg", null);
    __publicField(this, "grain", null);
    __publicField(this, "grid", makeGrid(COLS, ROWS));
    __publicField(this, "gridPrev", makeGrid(COLS, ROWS));
    __publicField(this, "proj", new Float32Array(2048 * 3));
    __publicField(this, "screenGeo", { pitch: 0, x0: 0, y0: 0 });
  }
  prepare(shape, unit, led) {
    if (Math.abs(unit - this.unit) > 0.5 || shape !== this.shape) {
      this.unit = unit;
      this.shape = shape;
      this.meshes = headMeshes(shape);
      const b = bakesFor(shape, unit);
      this.front = b.front;
      this.back = b.back;
      this.glass = b.glass;
      const sc = screenOf(shape);
      this.screen = makeCanvas(sc.hx * 2 * unit, sc.hy * 2 * unit);
      this.ledKey = "";
      const gl = glassOf(shape);
      this.grid = makeGrid(Math.ceil(gl.hx * 2 / shape.pitch), Math.ceil(gl.hy * 2 / shape.pitch));
      this.gridPrev = makeGrid(this.grid.cols, this.grid.rows);
      this.tiny = makeCanvas(this.grid.cols, this.grid.rows);
      this.tinyHalf = makeCanvas(Math.ceil(this.grid.cols / 2), Math.ceil(this.grid.rows / 2));
      this.tinyImg = null;
      const pitch = shape.pitch * unit;
      this.screenGeo = {
        pitch,
        x0: (this.screen.width - pitch * this.grid.cols) / 2,
        y0: (this.screen.height - pitch * this.grid.rows) / 2
      };
    }
    const key = led.join(",");
    if (key !== this.ledKey && this.screen) {
      this.ledKey = key;
      const { pitch, x0, y0 } = this.screenGeo;
      this.screenBase = bakeScreenBase(this.screen.width, this.screen.height, pitch, x0, y0, led);
    }
  }
  /* the LED matrix for this frame */
  compose(sim, state) {
    const grid = this.grid;
    const g = grid.v;
    const { cols, rows } = grid;
    g.fill(0);
    if (!sim) {
      FACES[state](grid, { lookX: 0, lookY: 0, blink: 0, time: 0.4, side: 1, seed: 0 });
      return grid;
    }
    FACES[sim.shown](grid, sim.face);
    if (sim.switched < 0.3) {
      const p = this.gridPrev;
      p.v.fill(0);
      FACES[sim.previous](p, { ...sim.face, time: sim.face.time + 10 });
      const k = sim.switched / 0.3;
      for (let i = 0; i < g.length; i++) g[i] = g[i] * k + p.v[i] * (1 - k);
      if (sim.switched < 0.13) {
        const seed = Math.floor(sim.time * 30);
        for (let r = 0; r < rows; r++) {
          const shift = Math.floor((Math.sin(seed * 12.9 + r * 78.2) * 0.5 + 0.5) * 3) - 1;
          if (!shift) continue;
          const row = g.slice(r * cols, (r + 1) * cols);
          for (let c = 0; c < cols; c++) g[r * cols + c] = row[(c - shift + cols) % cols];
        }
        for (let i = 0; i < g.length; i++) if (Math.sin(i * 91.7 + seed * 3.1) > 0.93) g[i] = Math.max(g[i], 0.3);
      }
    }
    if (sim.age < 0.55) {
      const open = smooth(0.08, 0.5, sim.age) * (rows / 2 + 0.5);
      for (let r = 0; r < rows; r++) {
        const d = Math.abs(r - (rows - 1) / 2);
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          if (d > open) g[i] = 0;
          else if (d > open - 1.2) g[i] = Math.max(g[i], 0.85 * (1 - sim.age / 0.55));
        }
      }
    }
    return grid;
  }
  drawScreen(grid, led) {
    const s = this.screen;
    const ctx = s.getContext("2d");
    const { cols, rows, v: g } = grid;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(this.screenBase, 0, 0);
    const { pitch, x0, y0 } = this.screenGeo;
    const core = mix(led, [255, 255, 255], 0.6);
    const coreCss = `rgb(${core.map(Math.round).join(",")})`;
    const bleedCss = `rgb(${led.map(Math.round).join(",")})`;
    const cell = pitch * 0.8, off = (pitch - cell) / 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = g[r * cols + c];
        if (v < 0.01) continue;
        ctx.globalAlpha = Math.min(1, v * 0.4);
        ctx.fillStyle = bleedCss;
        ctx.fillRect(x0 + c * pitch + off * 0.4, y0 + r * pitch + off * 0.4, pitch - off * 0.8, pitch - off * 0.8);
        ctx.globalAlpha = Math.min(1, v);
        ctx.fillStyle = coreCss;
        ctx.fillRect(x0 + c * pitch + off, y0 + r * pitch + off, cell, cell);
      }
    }
    const t = this.tiny.getContext("2d");
    if (!this.tinyImg) this.tinyImg = t.createImageData(cols, rows);
    const d = this.tinyImg.data;
    for (let i = 0; i < cols * rows; i++) {
      d[i * 4] = led[0];
      d[i * 4 + 1] = led[1];
      d[i * 4 + 2] = led[2];
      d[i * 4 + 3] = Math.round(Math.min(1, g[i]) * 255);
    }
    t.putImageData(this.tinyImg, 0, 0);
    const h = this.tinyHalf.getContext("2d");
    h.clearRect(0, 0, this.tinyHalf.width, this.tinyHalf.height);
    h.imageSmoothingEnabled = true;
    h.drawImage(this.tiny, 0, 0, this.tinyHalf.width, this.tinyHalf.height);
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.7;
    ctx.drawImage(this.tiny, x0, y0, cols * pitch, rows * pitch);
    ctx.globalAlpha = 0.65;
    ctx.drawImage(this.tinyHalf, x0 - pitch, y0 - pitch, (cols + 2) * pitch, (rows + 2) * pitch);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(this.glass, 0, 0);
  }
  /** Draw a frame; `frame` is in CSS px, the canvas in device px (`dpr` per CSS px). */
  draw(ctx, frame, dpr, pose, sim, state, shape, palette, opts) {
    const U = frame.unit * dpr;
    const PLATE = plateOf(shape);
    const GLASS = glassOf(shape);
    const SCREEN = screenOf(shape);
    const shown = sim ? sim.shown : state;
    const lightNow = LIGHTS[shown];
    let led = lightNow.screen ?? palette.led;
    if (sim && sim.switched < 0.3) {
      const was = LIGHTS[sim.previous].screen ?? palette.led;
      led = mix(was, led, sim.switched / 0.3).map(Math.round);
    }
    this.prepare(shape, U, led);
    if (!this.layer || this.layer.width !== ctx.canvas.width || this.layer.height !== ctx.canvas.height) {
      this.layer = makeCanvas(ctx.canvas.width, ctx.canvas.height);
      this.grain = grainPattern(ctx);
    }
    const layer = this.layer.getContext("2d");
    const R = rotation(pose.yaw, pose.pitch, pose.roll);
    const cx = frame.cx * dpr + pose.x * U;
    const rest = frame.cy * dpr;
    const cy = rest - pose.lift * U;
    const by = cy + shape.hy * U;
    const P = (x, y, z) => {
      const r = rotate(R, x, y, z);
      return [cx + r[0] * U * pose.sx, by + (cy + r[1] * U - by) * pose.sy, r[2]];
    };
    const plane = (c, z, flip) => {
      const o = P(0, 0, z), ex = P(flip ? -1 : 1, 0, z), ey = P(0, 1, z);
      c.setTransform(ex[0] - o[0], ex[1] - o[1], ey[0] - o[0], ey[1] - o[1], o[0], o[1]);
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (opts.floorShadow) {
      const up = Math.max(0, pose.lift);
      const fy = rest + (shape.hy + 0.11) * U;
      const rx = U * shape.hx * (1 - up * 0.9) * pose.sx;
      ctx.save();
      ctx.translate(frame.cx * dpr + pose.x * U, fy);
      ctx.scale(1, 0.16);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      const a = 0.55 * Math.max(0, 1 - up * 1.6);
      g.addColorStop(0, `rgba(0,0,0,${a})`);
      g.addColorStop(0.55, `rgba(0,0,0,${a * 0.45})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    const { body, earL, earR, collar } = this.meshes;
    const earLz = rotate(R, -shape.earX - 0.05, HEAD.earY, 0)[2];
    const earRz = rotate(R, shape.earX + 0.05, HEAD.earY, 0)[2];
    const topZ = rotate(R, 0, -shape.hy, 0)[2];
    const antennaBehind = topZ < -0.012;
    const drawMesh = (c, mesh, mat) => {
      const n = mesh.pos.length / 3;
      const pr = this.proj;
      for (let i = 0; i < n; i++) {
        const p = P(mesh.pos[i * 3], mesh.pos[i * 3 + 1], mesh.pos[i * 3 + 2]);
        pr[i * 3] = p[0];
        pr[i * 3 + 1] = p[1];
        pr[i * 3 + 2] = p[2];
      }
      const order = [];
      const q = mesh.quads, nn = mesh.normals;
      for (let k = 0; k < q.length / 4; k++) {
        const nz = R[6] * nn[k * 3] + R[7] * nn[k * 3 + 1] + R[8] * nn[k * 3 + 2];
        if (nz < -0.03) continue;
        const z = pr[q[k * 4] * 3 + 2] + pr[q[k * 4 + 1] * 3 + 2] + pr[q[k * 4 + 2] * 3 + 2] + pr[q[k * 4 + 3] * 3 + 2];
        order.push([z, k]);
      }
      order.sort((a, b) => a[0] - b[0]);
      c.lineWidth = Math.max(0.6, U / 260);
      c.lineJoin = "round";
      for (const [, k] of order) {
        const nx = nn[k * 3], ny = nn[k * 3 + 1], nz0 = nn[k * 3 + 2];
        const w = rotate(R, nx, ny, nz0);
        const col = shadeCss(mat, w[0], w[1], w[2]);
        c.beginPath();
        for (let j = 0; j < 4; j++) {
          const vi = q[k * 4 + j] * 3;
          if (j) c.lineTo(pr[vi], pr[vi + 1]);
          else c.moveTo(pr[vi], pr[vi + 1]);
        }
        c.closePath();
        c.fillStyle = col;
        c.strokeStyle = col;
        c.fill();
        c.stroke();
      }
    };
    const antenna = () => this.drawAntenna(ctx, P, U, pose, palette, sim, shown, lightNow, collar, opts.antenna);
    if (antennaBehind) antenna();
    if (earLz < 0) drawMesh(ctx, earL, palette.trim);
    if (earRz < 0) drawMesh(ctx, earR, palette.trim);
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalCompositeOperation = "source-over";
    layer.clearRect(0, 0, this.layer.width, this.layer.height);
    drawMesh(layer, body, palette.shell);
    const frontZ = R[8];
    const zf = shape.depth / 2;
    const facing = Math.abs(frontZ) > 5e-3 ? frontZ > 0 ? 1 : -1 : 0;
    if (facing) {
      const dome = 0.17;
      plane(layer, facing * zf, facing < 0);
      const at = (dx, dy) => {
        const w = rotate(R, dx * (facing < 0 ? -1 : 1), dy, facing);
        const l = Math.hypot(w[0], w[1], w[2]);
        return css(radiance(palette.shell, w[0] / l, w[1] / l, w[2] / l));
      };
      layer.beginPath();
      shape.path(layer, INSET.plate - 2e-3);
      const vg = layer.createLinearGradient(0, -PLATE.hy, 0, PLATE.hy);
      vg.addColorStop(0, at(0, -dome));
      vg.addColorStop(0.5, at(0, 0));
      vg.addColorStop(1, at(0, dome));
      layer.fillStyle = vg;
      layer.fill();
      const hg = layer.createLinearGradient(-PLATE.hx, 0, PLATE.hx, 0);
      hg.addColorStop(0, at(-dome, 0));
      hg.addColorStop(0.5, at(0, 0));
      hg.addColorStop(1, at(dome, 0));
      layer.globalAlpha = 0.5;
      layer.fillStyle = hg;
      layer.fill();
      layer.globalAlpha = 1;
    }
    if (this.grain) {
      layer.setTransform(1, 0, 0, 1, 0, 0);
      layer.globalCompositeOperation = "source-atop";
      const m = typeof DOMMatrix === "function" ? new DOMMatrix().translate(cx, cy) : null;
      if (m && "setTransform" in this.grain) this.grain.setTransform(m);
      layer.fillStyle = this.grain;
      layer.fillRect(0, 0, this.layer.width, this.layer.height);
      layer.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(this.layer, 0, 0);
    if (facing > 0) {
      ctx.save();
      plane(ctx, zf, false);
      ctx.beginPath();
      shape.path(ctx, INSET.hole);
      ctx.fillStyle = "#060709";
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      shape.path(ctx, INSET.glass);
      ctx.clip();
      this.drawScreen(this.compose(sim, state), led);
      plane(ctx, zf - HEAD.recess, false);
      ctx.drawImage(this.screen, -SCREEN.hx, -SCREEN.hy, SCREEN.hx * 2, SCREEN.hy * 2);
      plane(ctx, zf, false);
      const s = -0.05 - pose.yaw * 0.9 + pose.pitch * 0.5;
      const sg = ctx.createLinearGradient(-0.55 + s, -0.35, 0.15 + s, 0.35);
      sg.addColorStop(0, "rgba(255,255,255,0)");
      sg.addColorStop(0.36, "rgba(255,255,255,0)");
      sg.addColorStop(0.43, "rgba(220,232,255,0.075)");
      sg.addColorStop(0.5, "rgba(255,255,255,0)");
      sg.addColorStop(0.58, "rgba(255,255,255,0)");
      sg.addColorStop(0.61, "rgba(220,232,255,0.04)");
      sg.addColorStop(0.65, "rgba(255,255,255,0)");
      ctx.fillStyle = sg;
      ctx.fillRect(-GLASS.hx, -GLASS.hy, GLASS.hx * 2, GLASS.hy * 2);
      ctx.restore();
      ctx.drawImage(this.front, -PLATE.hx, -PLATE.hy, PLATE.hx * 2, PLATE.hy * 2);
      ctx.restore();
    } else if (facing < 0) {
      ctx.save();
      plane(ctx, -zf, true);
      ctx.drawImage(this.back, -PLATE.hx, -PLATE.hy, PLATE.hx * 2, PLATE.hy * 2);
      ctx.restore();
    }
    if (earLz >= 0) drawMesh(ctx, earL, palette.trim);
    if (earRz >= 0) drawMesh(ctx, earR, palette.trim);
    if (!antennaBehind) antenna();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  drawAntenna(ctx, P, U, pose, palette, sim, shown, lightNow, collar, stem) {
    const R = rotation(pose.yaw, pose.pitch, pose.roll);
    const pr = this.proj;
    const n = collar.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const p = P(collar.pos[i * 3], collar.pos[i * 3 + 1], collar.pos[i * 3 + 2]);
      pr[i * 3] = p[0];
      pr[i * 3 + 1] = p[1];
      pr[i * 3 + 2] = p[2];
    }
    const q = collar.quads, nn = collar.normals;
    ctx.lineWidth = Math.max(0.6, U / 260);
    for (let k = 0; k < q.length / 4; k++) {
      const w = rotate(R, nn[k * 3], nn[k * 3 + 1], nn[k * 3 + 2]);
      if (w[2] < -0.03) continue;
      const col = shadeCss(palette.trim, w[0], w[1], w[2]);
      ctx.beginPath();
      for (let j = 0; j < 4; j++) {
        const vi = q[k * 4 + j] * 3;
        if (j) ctx.lineTo(pr[vi], pr[vi + 1]);
        else ctx.moveTo(pr[vi], pr[vi + 1]);
      }
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      ctx.fill();
      ctx.stroke();
    }
    if (!stem) return;
    const top = -this.shape.hy - 0.028;
    const L = HEAD.stem;
    const ax = pose.antennaX, az = pose.antennaZ;
    const dir = [Math.sin(ax), -Math.cos(ax) * Math.cos(az), Math.sin(az)];
    const base = P(0, top, 0);
    const ctrl = P(0, top - L * 0.55, 0);
    const tip = P(dir[0] * L, top + dir[1] * L, dir[2] * L);
    const ballC = P(dir[0] * (L + HEAD.ball * 0.8), top + dir[1] * (L + HEAD.ball * 0.8), dir[2] * (L + HEAD.ball * 0.8));
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(base[0], base[1]);
    ctx.quadraticCurveTo(ctrl[0], ctrl[1], tip[0], tip[1]);
    ctx.lineWidth = U * 0.02;
    ctx.strokeStyle = "#4a5260";
    ctx.stroke();
    ctx.lineWidth = U * 9e-3;
    ctx.strokeStyle = "#9aa3b1";
    ctx.stroke();
    ctx.save();
    ctx.translate(-U * 4e-3, 0);
    ctx.lineWidth = U * 4e-3;
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.stroke();
    ctx.restore();
    let colour = lightNow.ball;
    let level = lightNow.pulse(sim ? sim.face.time : 0.3);
    if (sim && sim.switched < 0.3) {
      const was = LIGHTS[sim.previous];
      const k = sim.switched / 0.3;
      colour = mix(was.ball, colour, k);
      level = was.pulse(sim.face.time + 10) * (1 - k) + level * k;
    }
    if (sim && sim.age < 0.55) level *= smooth(0.1, 0.5, sim.age);
    void shown;
    const r = HEAD.ball * U * pose.sx;
    const [bx, by] = ballC;
    const frost = [168, 174, 186];
    const lit = mix(frost, mix(colour, [255, 255, 255], 0.35), level);
    const glassTint = mix([150, 158, 172], colour, 0.5);
    const shoulder = mix(lit, glassTint, 0.48);
    const edge = mix([70, 76, 88], mix(colour, [90, 96, 108], 0.5), level * 0.55);
    const g = ctx.createRadialGradient(bx - r * 0.18, by - r * 0.22, r * 0.05, bx, by, r);
    g.addColorStop(0, `rgb(${mix(lit, [255, 255, 255], 0.6 + level * 0.3).map(Math.round).join(",")})`);
    g.addColorStop(0.38, `rgb(${lit.map(Math.round).join(",")})`);
    g.addColorStop(0.78, `rgb(${shoulder.map(Math.round).join(",")})`);
    g.addColorStop(1, `rgb(${edge.map(Math.round).join(",")})`);
    if (level > 0.01) {
      ctx.globalCompositeOperation = "lighter";
      const glow = ctx.createRadialGradient(bx, by, r * 0.6, bx, by, r * 4.2);
      const c = colour.map(Math.round).join(",");
      glow.addColorStop(0, `rgba(${c},${0.5 * level})`);
      glow.addColorStop(0.35, `rgba(${c},${0.14 * level})`);
      glow.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(bx, by, r * 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }
    const seat = ctx.createRadialGradient(bx, by + r * 0.9, 0, bx, by + r * 0.9, r * 0.7);
    seat.addColorStop(0, "rgba(20,24,32,0.28)");
    seat.addColorStop(1, "rgba(20,24,32,0)");
    ctx.fillStyle = seat;
    ctx.beginPath();
    ctx.arc(bx, by + r * 0.9, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = Math.max(0.75, r * 0.07);
    ctx.strokeStyle = "rgba(28,32,42,0.28)";
    ctx.stroke();
    const sp = ctx.createRadialGradient(bx - r * 0.38, by - r * 0.42, 0, bx - r * 0.38, by - r * 0.42, r * 0.38);
    sp.addColorStop(0, "rgba(255,255,255,0.95)");
    sp.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sp;
    ctx.fill();
  }
}
export {
  RobotRenderer,
  frameFor
};
