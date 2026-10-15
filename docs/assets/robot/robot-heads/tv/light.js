// Robot Heads by Fayaz Ahmed — MIT; see LICENSE. Ported to JavaScript for Lumen.
const n3 = (x, y, z) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};
const KEY = n3(-0.5, -0.78, 0.62);
const FILL = n3(0.85, 0.15, 0.5);
const BACK = n3(0.55, -0.55, -0.62);
const HALF = n3(KEY[0], KEY[1], KEY[2] + 1);
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function environment(rx, ry, rz) {
  const up = -ry;
  const horizon = 0.05 + 0.12 * smooth(-0.25, 0.3, up);
  const softbox = 1.1 * smooth(0.42, 0.78, up) * smooth(-0.9, -0.2, rz - 0.6 * Math.abs(rx));
  const window = 2.6 * smooth(0.86, 0.97, rx * KEY[0] + ry * KEY[1] + rz * KEY[2]);
  const strip = 0.5 * smooth(0.6, 0.85, -rx) * smooth(-0.35, 0.05, up) * (1 - smooth(0.2, 0.5, up));
  return horizon + softbox + window + strip;
}
const toLinear = (c) => Math.pow(c / 255, 2.2);
function linear(rgb) {
  return [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
}
function display(x) {
  const t = x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14);
  return Math.round(255 * Math.pow(Math.min(1, Math.max(0, t)), 1 / 2.2));
}
function radiance(m, nx, ny, nz, out = [0, 0, 0]) {
  const ndl = nx * KEY[0] + ny * KEY[1] + nz * KEY[2];
  const key = Math.max(0, (ndl + 0.12) / 1.12);
  const fill = Math.max(0, nx * FILL[0] + ny * FILL[1] + nz * FILL[2]);
  const sky = 0.5 - 0.5 * ny;
  const ndv = Math.max(0, nz);
  const fres = m.f0 + (1 - m.f0) * Math.pow(1 - ndv, 5);
  const rx = 2 * ndv * nx, ry = 2 * ndv * ny, rz = 2 * ndv * nz - 1;
  const env = environment(rx, ry, rz) * fres;
  const spec = m.spec * Math.pow(Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]), m.shininess);
  const back = Math.max(0, nx * BACK[0] + ny * BACK[1] + nz * BACK[2]);
  const rim = m.rim * back * back * Math.pow(1 - ndv, 1.6);
  const diffuse = 0.05 + 0.1 * sky + 1.25 * key + 0.16 * fill;
  for (let i = 0; i < 3; i++) {
    const a = m.albedo[i];
    const tint = 1 - m.metal + m.metal * a * 2.2;
    const rimTint = i === 0 ? 0.62 : i === 1 ? 0.78 : 1;
    out[i] = a * diffuse * (1 - fres * 0.6) + (env + spec) * tint + rim * rimTint * (0.35 + a);
  }
  return out;
}
function css(c, alpha = 1) {
  return alpha >= 1 ? `rgb(${display(c[0])},${display(c[1])},${display(c[2])})` : `rgba(${display(c[0])},${display(c[1])},${display(c[2])},${alpha})`;
}
function shadeCss(m, nx, ny, nz) {
  return css(radiance(m, nx, ny, nz));
}
function luma(c) {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export {
  KEY,
  css,
  linear,
  luma,
  radiance,
  shadeCss
};
