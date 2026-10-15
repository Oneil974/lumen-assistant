// Lumen XR — ambiances immersives du mode focus.
//
// La pièce s'estompe derrière un décor, à la manière des « environnements »
// des casques haut de gamme. Tout est PROCÉDURAL : un dôme peint par un
// shader (aucun fichier à télécharger, rien de lourd pour le Quest) et un son
// d'ambiance synthétisé (vagues, grillons, oiseaux, vent). Le dôme ignore la
// profondeur : sinon les murs réels, plus proches, le cacheraient entièrement.

import * as THREE from "/lib/three.module.js";

export const ENVIRONMENTS = [
  { id: "night", fr: "Nuit étoilée", en: "Starry night" },
  { id: "dawn", fr: "Aube", en: "Dawn" },
  { id: "ocean", fr: "Océan", en: "Ocean" },
];

const VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = `
precision highp float;
varying vec3 vDir;
uniform float uTime;
uniform float uOpacity;
uniform int uPreset;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash(vec3(i, 0.)), b = hash(vec3(i + vec2(1., 0.), 0.)), c = hash(vec3(i + vec2(0., 1.), 0.)), d = hash(vec3(i + vec2(1., 1.), 0.));
  vec2 u = f * f * (3. - 2. * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) { float v = 0., a = .5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= .5; } return v; }
vec3 stars(vec3 d, float density) {
  vec3 p = floor(d * 380.);
  float h = hash(p);
  float tw = .6 + .4 * sin(uTime * (1. + h * 3.) + h * 40.);
  return vec3(step(1. - density, h) * tw);
}
void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 col;
  if (uPreset == 0) {
    // Nuit étoilée + aurore.
    col = mix(vec3(.01, .015, .04), vec3(.02, .04, .1), smoothstep(-.1, .8, y));
    col += stars(d, .0035) * smoothstep(-.05, .2, y);
    float band = fbm(vec2(atan(d.z, d.x) * 2.5 + uTime * .03, y * 3. - uTime * .02));
    float aur = smoothstep(.15, .55, y) * smoothstep(.85, .45, y) * smoothstep(.45, .8, band);
    col += aur * mix(vec3(.1, .9, .5), vec3(.5, .2, .9), smoothstep(.3, .7, y)) * .55;
    col = mix(col, vec3(.0, .005, .015), smoothstep(.0, -.3, y));
  } else if (uPreset == 1) {
    // Aube : dégradé chaud, soleil bas, nuages qui passent.
    vec3 sunDir = normalize(vec3(.0, .08, -1.));
    float s = max(dot(d, sunDir), 0.);
    col = mix(vec3(.98, .62, .45), vec3(.35, .48, .78), smoothstep(-.05, .6, y));
    col += vec3(1., .75, .45) * pow(s, 40.) * 1.4 + vec3(1., .55, .35) * pow(s, 4.) * .35;
    float cl = fbm(vec2(atan(d.z, d.x) * 3. + uTime * .01, y * 6.));
    col = mix(col, vec3(1., .86, .8), smoothstep(.55, .8, cl) * smoothstep(.05, .35, y) * .6);
    col = mix(col, vec3(.18, .12, .16), smoothstep(.0, -.25, y));
  } else {
    // Océan : ciel clair, horizon, mer qui scintille.
    col = mix(vec3(.75, .86, .95), vec3(.25, .5, .85), smoothstep(.0, .7, y));
    if (y < 0.) {
      vec2 w = d.xz / max(.02, -y);
      float waves = fbm(w * .6 + vec2(uTime * .08, uTime * .05));
      vec3 sea = mix(vec3(.02, .18, .3), vec3(.05, .35, .5), waves);
      float glint = pow(max(0., waves - .55), 3.) * 6. * smoothstep(-.5, -.02, y);
      col = mix(vec3(.6, .75, .85), sea + glint, smoothstep(.0, -.08, y));
    }
  }
  gl_FragColor = vec4(col, uOpacity);
}`;

export function createEnvironment(ctx) {
  const { scene } = ctx;
  const uniforms = { uTime: { value: 0 }, uOpacity: { value: 0 }, uPreset: { value: 0 } };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(18, 64, 32),
    new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false,
      // Dessiné AVANT les objets opaques (rendu « opaque », ordre -20) mais
      // fondu sur le passthrough : mélange alpha personnalisé. En « transparent »,
      // il passait après les dossiers et les recouvrait.
      transparent: false, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor }),
  );
  dome.renderOrder = -20;
  dome.visible = false;
  dome.frustumCulled = false;
  scene.add(dome);
  let target = 0;
  let audio = null;

  // ---- Son d'ambiance --------------------------------------------------------
  function startAudio(preset) {
    stopAudio();
    const ac = ctx.audio?.();
    if (!ac) return;
    const master = ac.createGain();
    master.gain.value = 0;
    master.gain.setTargetAtTime(0.16, ac.currentTime, 1.2);
    master.connect(ac.destination);
    const nodes = [];
    const noiseSrc = () => {
      const b = ac.createBuffer(1, ac.sampleRate * 4, ac.sampleRate);
      const d = b.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } // bruit brun
      const s = ac.createBufferSource(); s.buffer = b; s.loop = true; s.start(); nodes.push(s); return s;
    };
    const lfo = (freq, depth, param, base) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = freq; g.gain.value = depth; param.value = base;
      o.connect(g).connect(param); o.start(); nodes.push(o);
    };
    let timer = null;
    if (preset === "ocean") {
      // Ressac : bruit filtré dont le volume monte et descend.
      const n = noiseSrc(), f = ac.createBiquadFilter(), g = ac.createGain();
      f.type = "lowpass"; lfo(0.11, 500, f.frequency, 700);
      lfo(0.11, 0.45, g.gain, 0.55);
      n.connect(f).connect(g).connect(master);
    } else if (preset === "night") {
      const n = noiseSrc(), f = ac.createBiquadFilter(), g = ac.createGain();
      f.type = "lowpass"; f.frequency.value = 300; g.gain.value = 0.25;
      n.connect(f).connect(g).connect(master);
      // Grillons : trilles aiguës par salves.
      timer = setInterval(() => {
        const t = ac.currentTime, o = ac.createOscillator(), a = ac.createGain();
        o.frequency.value = 4300 + Math.random() * 400;
        a.gain.setValueAtTime(0, t);
        for (let k = 0; k < 4; k++) { a.gain.setValueAtTime(0.05, t + k * 0.05); a.gain.setValueAtTime(0, t + k * 0.05 + 0.025); }
        o.connect(a).connect(master); o.start(t); o.stop(t + 0.25);
      }, 900 + Math.random() * 500);
    } else {
      const n = noiseSrc(), f = ac.createBiquadFilter(), g = ac.createGain();
      f.type = "bandpass"; f.frequency.value = 500; g.gain.value = 0.18;
      lfo(0.07, 0.1, g.gain, 0.18);
      n.connect(f).connect(g).connect(master);
      // Oiseaux : petits glissandos aléatoires.
      timer = setInterval(() => {
        if (Math.random() < 0.4) return;
        const t = ac.currentTime, o = ac.createOscillator(), a = ac.createGain();
        const f0 = 2200 + Math.random() * 1800;
        o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * (1.3 + Math.random() * 0.5), t + 0.12);
        a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(0.06, t + 0.02); a.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(a).connect(master); o.start(t); o.stop(t + 0.2);
      }, 700);
    }
    audio = { master, nodes, timer, ac };
  }
  function stopAudio() {
    if (!audio) return;
    const { master, nodes, timer, ac } = audio;
    clearInterval(timer);
    master.gain.setTargetAtTime(0, ac.currentTime, 0.4);
    setTimeout(() => { nodes.forEach((n) => { try { n.stop(); } catch {} }); master.disconnect(); }, 1800);
    audio = null;
  }

  return {
    get active() { return target > 0; },
    get presetIndex() { return uniforms.uPreset.value; },
    /** `opacity` < 1 : décor voilé, la pièce reste visible (rituel du matin). */
    show(index, { opacity = 1 } = {}) {
      const i = ((index % ENVIRONMENTS.length) + ENVIRONMENTS.length) % ENVIRONMENTS.length;
      uniforms.uPreset.value = i;
      dome.visible = true;
      target = opacity;
      startAudio(ENVIRONMENTS[i].id);
    },
    hide() { target = 0; stopAudio(); },
    next() { this.show(uniforms.uPreset.value + 1); return ENVIRONMENTS[uniforms.uPreset.value]; },
    tick(dt, headPos) {
      uniforms.uTime.value += dt;
      const o = uniforms.uOpacity.value;
      uniforms.uOpacity.value = o + (target - o) * Math.min(1, dt * 1.3);
      if (target === 0 && uniforms.uOpacity.value < 0.01) { uniforms.uOpacity.value = 0; dome.visible = false; }
      if (dome.visible) dome.position.copy(headPos); // le décor est à l'infini
    },
  };
}
