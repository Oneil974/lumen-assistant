import test from 'node:test';
import assert from 'node:assert/strict';
let createCanvas;
try { ({ createCanvas } = await import('@napi-rs/canvas')); } catch { /* Optional local rendering tool. */ }
import { robotState } from '../src/lib/robot-head.js';
import { getShape } from '../src/lib/robot-heads/tv/geometry.js';
import { RobotRenderer, frameFor } from '../src/lib/robot-heads/tv/render.js';
import { RobotSim } from '../src/lib/robot-heads/tv/sim.js';
import { linear } from '../src/lib/robot-heads/tv/light.js';

test('Lumen activities take priority over robot moods', () => {
  assert.equal(robotState({ state: 'speaking', action: 'executing', mood: 'sleep' }), 'working');
  assert.equal(robotState({ state: 'thinking', mood: 'sleep' }), 'thinking');
  for (const state of ['idle', 'thinking', 'speaking', 'listening', 'searching', 'error']) assert.equal(robotState({state}), state);
  assert.equal(robotState({mood: 'sleep'}), 'sleeping');
  assert.equal(robotState({mood: 'happy'}), 'happy');
  assert.equal(robotState({state: 'unknown'}), 'idle');
});

test('ported Canvas renderer draws all robot states without React or WebGL', { skip: !createCanvas && 'Optional @napi-rs/canvas unavailable' }, () => {
  globalThis.document = { createElement: () => createCanvas(1, 1) };
  try {
    const renderer = new RobotRenderer();
    const shape = getShape('rectangle');
    const f = frameFor(shape, true, 116);
    const canvas = createCanvas(Math.ceil(f.box + 2*f.padSide), Math.ceil(f.box + f.padTop + f.padBottom));
    const palette = { shell: {albedo: linear([43,73,163]), f0:.05, metal:.15, spec:.55, shininess:70, rim:.9}, trim: {albedo:linear([147,166,200]), f0:.2, metal:.65, spec:.8, shininess:45, rim:.7}, led:[232,242,255] };
    const signatures = new Set();
    for (const state of ['idle','thinking','searching','listening','speaking','working','happy','error','sleeping']) {
      const sim = new RobotSim(.3, state); sim.update(.05);
      renderer.draw(canvas.getContext('2d'), f, 1, sim.pose, sim, state, shape, palette, {floorShadow:true, antenna:true});
      const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      assert.ok(pixels.some((value,index) => index%4===3 && value>0), state);
      signatures.add(canvas.toBuffer('image/png').toString('base64'));
    }
    assert.equal(signatures.size, 9);
  } finally { delete globalThis.document; }
});

test('robot settings validate persisted JSON, booleans, colors and speed', async () => {
  const {normalizeRobotOptions, ROBOT_DEFAULTS} = await import('../src/lib/robot-head.js');
  assert.deepEqual(normalizeRobotOptions('{broken'), ROBOT_DEFAULTS);
  const options = normalizeRobotOptions(JSON.stringify({shape:'hexagon',color:'#ff3366',trimColor:'#ddeeff',screenColor:'#aaff33',speed:2,antenna:false,paused:true,floorShadow:false,interactive:false}));
  assert.equal(options.shape, 'hexagon'); assert.equal(options.speed, 2);
  assert.equal(options.color, '#ff3366'); assert.equal(options.antenna, false); assert.equal(options.paused, true);
  assert.equal(options.floorShadow, false); assert.equal(options.interactive, false);
  assert.equal(normalizeRobotOptions({shape:'<invalid>', color:'url(x)',speed:99}).shape, 'rectangle');
  assert.equal(normalizeRobotOptions({speed:99}).speed, 3);
  assert.equal(normalizeRobotOptions({speed:-1}).speed, 0);
});

test('all shapes preserve resting centre across Lumen surface sizes', () => {
  for (const size of [34, 104, 116, 180]) for (const shape of ['rectangle','square','circle','hexagon']) for (const antenna of [true,false]) {
    const frame = frameFor(getShape(shape),antenna,size);
    assert.equal(frame.cx - frame.padSide, size/2);
    assert.ok(frame.cy - frame.padTop > 0 && frame.cy - frame.padTop < size);
    assert.ok(frame.box + 2*frame.padSide >= size);
  }
});
