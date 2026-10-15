// Native Canvas adapter for Robot Heads by Fayazara (MIT).
import { getShape } from './robot-heads/tv/geometry.js';
import { RobotSim, restPose } from './robot-heads/tv/sim.js';
import { RobotRenderer, frameFor } from './robot-heads/tv/render.js';
import { parseColor } from './robot-heads/color.js';
import { linear } from './robot-heads/tv/light.js';
import { subscribe, pointer } from './robot-heads/ticker.js';

export function robotState({ state = 'idle', action, mood } = {}) {
  if (action) return 'working';
  if (state !== 'idle') return ['thinking', 'speaking', 'listening', 'searching', 'working', 'error'].includes(state) ? state : 'idle';
  if (mood === 'sleep') return 'sleeping';
  if (['happy', 'joy', 'love', 'excited'].includes(mood)) return 'happy';
  if (['sad', 'angry', 'error'].includes(mood)) return 'error';
  return 'idle';
}

export const ROBOT_DEFAULTS = Object.freeze({ shape: 'rectangle', color: '#2b49a3', trimColor: '#93a6c8', screenColor: '#e8f2ff', speed: 1, paused: false, antenna: true, floorShadow: true, interactive: true });
export function normalizeRobotOptions(value) {
  let input = value;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
  const a = input && typeof input === 'object' ? input : {};
  const result = { ...ROBOT_DEFAULTS };
  if (['rectangle', 'square', 'circle', 'hexagon'].includes(a.shape)) result.shape = a.shape;
  for (const key of ['color', 'trimColor', 'screenColor']) if (typeof a[key] === 'string' && /^#[0-9a-f]{6}$/i.test(a[key])) result[key] = a[key];
  if (a.speed != null && Number.isFinite(Number(a.speed))) result.speed = Math.max(0, Math.min(3, Number(a.speed)));
  for (const key of ['paused', 'antenna', 'floorShadow', 'interactive']) if (a[key] != null) result[key] = a[key] === true || a[key] === 'true';
  return result;
}

export function mountRobotHead(host, { paused = false } = {}) {
  if (!document.querySelector('[data-robot-head-style]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = new URL('./robot-head.css', import.meta.url).href;
    link.dataset.robotHeadStyle = ''; document.head.append(link);
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'lumen-robot-head';
  canvas.setAttribute('role', 'img');
  Object.assign(canvas.style, { position: 'absolute', pointerEvents: 'none', display: 'none', zIndex: '3' });
  host.append(canvas);
  const sim = new RobotSim(0.3, 'idle');
  const renderer = new RobotRenderer();
  let options = normalizeRobotOptions(localStorage.getItem('robotHeadOptions'));
  let shape = getShape(options.shape);
  const palette = {
    shell: { albedo: linear([43, 73, 163]), f0: 0.05, metal: 0.15, spec: 0.55, shininess: 70, rim: 0.9 },
    trim: { albedo: linear([147, 166, 200]), f0: 0.2, metal: 0.65, spec: 0.8, shininess: 45, rim: 0.7 },
    led: [232, 242, 255],
  };
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let active = false, enabled = true, unsubscribe = null;
  function paint(dt = 0) {
    const state = robotState(host.dataset);
    sim.setState(state);
    const size = host.clientWidth || 116;
    const frame = frameFor(shape, options.antenna, size);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = frame.box + 2 * frame.padSide, h = frame.box + frame.padTop + frame.padBottom;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    Object.assign(canvas.style, { left: `${-frame.padSide}px`, top: `${-frame.padTop}px`, width: `${w}px`, height: `${h}px` });
    for (const [key, value] of Object.entries({ '--robot-left': `${-frame.padSide}px`, '--robot-top': `${-frame.padTop}px`, '--robot-width': `${w}px`, '--robot-height': `${h}px` })) canvas.style.setProperty(key, value);
    const still = paused || options.paused || options.speed === 0 || motion.matches;
    const box = host.getBoundingClientRect();
    sim.pointer = options.interactive && Number.isFinite(pointer.x) ? { x: pointer.x - box.left - box.width / 2, y: pointer.y - box.top - frame.cy + frame.padTop } : null;
    if (!still) sim.update(dt * options.speed);
    canvas.setAttribute('aria-label', `Robot Head, ${state}`);
    const ctx = canvas.getContext('2d');
    if (ctx) renderer.draw(ctx, frame, dpr, still ? restPose(state) : sim.pose, still ? null : sim, state, shape, palette, { floorShadow: options.floorShadow, antenna: options.antenna });
  }
  function sync() {
    unsubscribe?.(); unsubscribe = null;
    canvas.style.display = active && enabled ? 'block' : 'none';
    if (!active || !enabled || document.hidden) return;
    paint();
    if (!paused && !options.paused && options.speed > 0 && !motion.matches) unsubscribe = subscribe(paint);
  }
  const observer = new MutationObserver(() => { if (active && enabled && !document.hidden && (paused || options.paused || options.speed === 0 || motion.matches)) paint(); });
  observer.observe(host, { attributes: true, attributeFilter: ['data-state', 'data-action', 'data-mood'] });
  const resize = new ResizeObserver(() => { if (active && enabled && !document.hidden) paint(); });
  resize.observe(host);
  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', sync);
  const poke = () => { if (active && enabled && options.interactive && !paused && !options.paused && !motion.matches && options.speed > 0) sim.poke(); };
  host.addEventListener('click', poke);
  function settings(value) {
    options = normalizeRobotOptions(value); shape = getShape(options.shape);
    palette.shell.albedo = linear(parseColor(options.color));
    palette.trim.albedo = linear(parseColor(options.trimColor));
    palette.led = parseColor(options.screenColor);
    sync();
  }
  settings(options);
  return {
    settings,
    setActive(on) { active = !!on; sync(); },
    setEnabled(on) { enabled = !!on; sync(); },
    dispose() { host.removeEventListener('click', poke); unsubscribe?.(); observer.disconnect(); resize.disconnect(); document.removeEventListener('visibilitychange', sync); motion.removeEventListener('change', sync); canvas.remove(); },
  };
}
