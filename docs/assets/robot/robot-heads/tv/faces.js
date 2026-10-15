// Robot Heads by Fayaz Ahmed — MIT; see LICENSE. Ported to JavaScript for Lumen.
const COLS = 22;
const ROWS = 14;
function makeGrid(cols, rows) {
  const c = COLS + 2 * Math.max(0, Math.ceil((cols - COLS) / 2));
  const r = ROWS + 2 * Math.max(0, Math.ceil((rows - ROWS) / 2));
  return { v: new Float32Array(c * r), cols: c, rows: r, ox: (c - COLS) / 2, oy: (r - ROWS) / 2 };
}
const put = (g, c, r, v) => {
  const x = c + g.ox, y = r + g.oy;
  if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return;
  const i = y * g.cols + x;
  if (v > g.v[i]) g.v[i] = v;
};
const rect = (g, c, r, w, h, v) => {
  for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) put(g, x, y, v);
};
const sprite = (g, c, r, rows, v) => {
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "#") put(g, c + x, r + y, v);
      else if (row[x] === "+") put(g, c + x, r + y, v * 0.5);
    }
  });
};
const EYE_L = 6;
const EYE_R = 13;
const EYE_TOP = 5;
function eyes(g, f, h = 4, v = 1, dy = 0, lid = 0) {
  const dx = Math.round(f.lookX);
  const ly = Math.round(f.lookY) + dy;
  const open = Math.max(1, Math.round(h - (h - 1) * f.blink));
  const top = EYE_TOP + Math.floor((4 - h) / 2) + ly + Math.floor((h - open) / 2);
  for (const c of [EYE_L, EYE_R]) {
    if (lid > 0 && open > 1) {
      rect(g, c + dx, top, 3, 1, v * (1 - lid));
      rect(g, c + dx, top + 1, 3, open - 1, v);
    } else rect(g, c + dx, top, 3, open, v);
  }
}
const noise = (x) => {
  return 0.5 + 0.25 * Math.sin(x * 1.7) + 0.15 * Math.sin(x * 3.1 + 1.3) + 0.1 * Math.sin(x * 5.3 + 4.1);
};
const CARET = ["..#..", ".#.#.", "#...#"];
const CROSS = ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"];
const Z_BIG = ["####", "..#.", ".#..", "####"];
const Z_SMALL = ["###", ".#.", "###"];
const FACES = {
  idle(g, f) {
    eyes(g, f);
  },
  thinking(g, f) {
    eyes(g, { ...f, lookX: f.lookX + f.side * 1.4, lookY: f.lookY - 1.2 }, 3, 1, 0, 0.45);
    for (let i = 0; i < 3; i++) {
      const p = (f.time * 1.6 - i * 0.22) % 1;
      const pulse = p < 0.35 ? Math.sin(p / 0.35 * Math.PI) : 0;
      rect(g, 6 + i * 4, 11 - (pulse > 0.5 ? 1 : 0), 2, 2, 0.28 + 0.72 * pulse);
    }
  },
  searching(g, f) {
    eyes(g, f);
    const first = -g.ox, last = COLS - 1 + g.ox;
    const sweep = first + (Math.sin(f.time * 1.6 + 0.4) * 0.5 + 0.5) * (last - first);
    const dir = Math.cos(f.time * 1.6 + 0.4) > 0 ? -1 : 1;
    for (let k = 0; k < 5; k++) {
      const c = Math.round(sweep + dir * k);
      const v = 0.32 * (1 - k / 5);
      for (let r = -g.oy; r < ROWS + g.oy; r++) put(g, c, r, v);
    }
  },
  listening(g, f) {
    eyes(g, f, 4, 1, -1);
    for (let i = 0; i < 12; i++) {
      const centre = 1 - Math.abs(i - 5.5) / 7;
      const level = noise(f.time * 7 + i * 1.9 + f.seed * 10) * centre;
      const h = Math.max(1, Math.round(level * 4));
      for (let k = 0; k < h; k++) put(g, 5 + i, 12 - k, 0.75 - k * 0.12);
    }
  },
  speaking(g, f) {
    eyes(g, f, 4, 1, -1);
    const env = Math.max(0, Math.sin(f.time * 2.1) * 0.5 + Math.sin(f.time * 3.7 + 1) * 0.5);
    for (let i = 0; i < 8; i++) {
      const centre = 1 - Math.abs(i - 3.5) / 5;
      const a = noise(f.time * 11 + i * 0.9) * centre * (0.35 + env);
      const h = a > 0.55 ? 3 : a > 0.28 ? 2 : 1;
      const top = h === 3 ? 10 : 11;
      const rows = h === 3 ? 3 : h === 2 ? 2 : 1;
      rect(g, 7 + i, top, 1, rows, 1);
    }
  },
  working(g, f) {
    eyes(g, { ...f, lookY: f.lookY + 1 }, 2, 1, 0);
    const p = f.time / 2.6 % 1;
    const fill = Math.round(p * 12);
    for (let i = 0; i < 12; i++) put(g, 5 + i, 11, i < fill ? 0.95 : 0.16);
    put(g, 4, 11, 0.4);
    put(g, 17, 11, 0.4);
  },
  happy(g, f) {
    const hop = Math.round(Math.max(0, Math.sin(f.time * 5.6)) * -1);
    sprite(g, EYE_L - 1, EYE_TOP + hop, CARET, 1);
    sprite(g, EYE_R - 1, EYE_TOP + hop, CARET, 1);
    sprite(g, 7, 10 + hop, ["#......#", ".######."], 0.9);
  },
  error(g, f) {
    const on = Math.sin(f.time * 7) > -0.6 ? 1 : 0.55;
    sprite(g, EYE_L - 1, 4, CROSS, on);
    sprite(g, EYE_R - 1, 4, CROSS, on);
    for (let i = 0; i < 8; i++) put(g, 7 + i, i % 2 ? 11 : 12, 0.8);
  },
  sleeping(g, f) {
    for (const c of [EYE_L, EYE_R]) {
      put(g, c - 1, 7, 0.32);
      rect(g, c, 8, 3, 1, 0.42);
      put(g, c + 3, 7, 0.32);
    }
    for (const [delay, big] of [[0, true], [1.1, false]]) {
      const p = (f.time + delay) / 2.2 % 1;
      const v = Math.sin(p * Math.PI) * 0.6;
      const y = Math.round(5 - p * 5);
      const x = 16 + Math.round(p * 2);
      sprite(g, x, y, big ? Z_BIG : Z_SMALL, v);
    }
  }
};
const steady = (v) => () => v;
const LIGHTS = {
  idle: { screen: null, ball: [255, 250, 240], pulse: (t) => 0.75 + 0.1 * Math.sin(t * 1.4) },
  thinking: { screen: null, ball: [255, 184, 64], pulse: (t) => 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 4.2)) },
  searching: { screen: null, ball: [90, 220, 255], pulse: (t) => t * 2.4 % 1 < 0.18 ? 1 : 0.25 },
  listening: { screen: null, ball: [96, 255, 150], pulse: steady(0.95) },
  speaking: { screen: null, ball: [255, 250, 240], pulse: (t) => 0.55 + 0.45 * noise(t * 11) },
  working: { screen: null, ball: [110, 160, 255], pulse: (t) => t * 1.7 % 1 < 0.5 ? 1 : 0.35 },
  happy: { screen: null, ball: [255, 130, 200], pulse: (t) => 0.8 + 0.2 * Math.sin(t * 8) },
  error: { screen: [255, 70, 64], ball: [255, 60, 50], pulse: (t) => t * 3 % 1 < 0.5 ? 1 : 0.15 },
  sleeping: { screen: null, ball: [255, 250, 240], pulse: steady(0) }
};
export {
  COLS,
  FACES,
  LIGHTS,
  ROWS,
  makeGrid
};
