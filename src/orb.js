import { mountRobotHead } from './lib/robot-head.js';
import { characterId } from './lib/orb-characters.js';
import { mountSoftOrb } from './lib/soft-orb.js?v=5';
// Lumen companion orb — a thin glass sphere with animated color blobs.
// Exposes window.LumenOrb: setState, setColors, setSize, setEnabled.
import * as THREE from './lib/three.module.js';
import { GLTFLoader } from './lib/loaders/GLTFLoader.js?v=2';
import { envelopeLevel, syntheticLevel, mouthScale, mouthOpacity, mouthSizeFromEye, MOUTH_FALLBACK } from './lib/voice-mouth.js?v=6';
import { defaultOrbColors } from './lib/orb-palette.js';
import { stopAllSpeech } from './lib/voice-stop.js';
import { createOrbMaterials } from './lib/orb-materials.js';
import { playUi } from './lib/ui-sounds.js';

(function () {
  const container = document.getElementById('orb-container');
  const orbWrap = document.getElementById('orb-wrap');
  const canvas = document.getElementById('orb-canvas');
  const eyesEl = document.getElementById('orb-eyes');
  const frostEl = container?.querySelector('.orb-frost');
  const shadowEl = orbWrap?.querySelector('.orb-shadow');
  const ambientGlowEl = document.querySelector('.glowing-orb');
  if (!container || !canvas) return;
  const softOrb = mountSoftOrb(container);
  let selectedCharacter = characterId(localStorage.getItem('orbTheme') || 'default');
  const performanceMode = localStorage.getItem('lumenPerfMode') === 'true';
  const robotHead = mountRobotHead(container, { paused: performanceMode });
  robotHead.setEnabled(localStorage.getItem('orbEnabled') !== 'false');
  softOrb.apply(selectedCharacter);
  function setCharacter(id) { selectedCharacter = characterId(id); softOrb.apply(selectedCharacter); queueMicrotask(() => { if (performanceMode) return; if (avatarMode === 'robot-head') { softOrb.apply('default'); stop(); } else if (selectedCharacter !== 'default') { setAvatarMode('orb'); stop(); } else if (orbEnabled && !document.hidden) start(); }); }
  window.addEventListener('pagehide', () => { softOrb.dispose(); robotHead.dispose(); }, { once: true });

  // ---- Mode performance (Raspberry Pi) -------------------------------------
  //
  // À ne pas confondre avec « Afficher l'avatar » (orbEnabled) : ce réglage-là
  // masque le canevas et arrête la boucle d'animation, mais le contexte WebGL a
  // déjà été créé, les shaders compilés, les deux sphères de 64×64 segments
  // construites et three.js entièrement chargé. Sur un Pi, ce coût est payé au
  // démarrage et la mémoire GPU reste prise, éteint ou non.
  //
  // Le mode performance, lui, sort AVANT toute création de contexte : aucun
  // WebGL n'est initialisé de la session. On laisse à sa place une façade
  // `LumenOrb` inerte — tous les appelants (barre, bureau, compagnon, AIPet)
  // passent par l'optionnel `?.`, mais plusieurs lisent une valeur de retour,
  // d'où les quelques accesseurs conservés.
  if (performanceMode) {
    const noop = () => {};
    const wrap = document.getElementById('orb-wrap');
    let perfEnabled = localStorage.getItem('orbEnabled') !== 'false';
    let perfRobot = localStorage.getItem('orbAvatarMode') === 'robot-head';
    function perfMode(mode) { perfRobot = mode === 'robot-head'; robotHead.setActive(perfRobot); softOrb.apply(perfRobot ? 'default' : selectedCharacter); container.dataset.avatarMode = perfRobot ? 'robot-head' : 'orb'; if (wrap) wrap.style.display = perfEnabled && (perfRobot || selectedCharacter !== 'default') ? '' : 'none'; }
    perfMode(localStorage.getItem('orbAvatarMode'));
    robotHead.setEnabled(perfEnabled);
    if (wrap) wrap.style.display = perfEnabled && (perfRobot || selectedCharacter !== 'default') ? '' : 'none';
    if (canvas) canvas.style.display = 'none';
    document.documentElement.classList.add('perf-mode');
    window.LumenOrb = new Proxy({
      setRobotHeadOptions: value => robotHead.settings(value),
      setAvatarMode: perfMode,
      setCharacter(id) { setCharacter(id); if (perfRobot) softOrb.apply('default'); if (wrap) wrap.style.display = perfEnabled && (perfRobot || selectedCharacter !== 'default') ? '' : 'none'; },
      setState(state) { container.dataset.state = state; },
      setMood(mood) { container.dataset.mood = mood; },
      setActionExecuting(on) { if (on) container.dataset.action = 'true'; else delete container.dataset.action; },
      setSize(size) { container.style.width = `${size}px`; container.style.height = `${size}px`; if (wrap) wrap.style.height = `${size + 12}px`; document.documentElement.style.setProperty('--orb-preferred-size', `${size}px`); },
      setEnabled(on) { perfEnabled = !!on; robotHead.setEnabled(on); container.dataset.softDisabled = String(!on); if (wrap) wrap.style.display = on && (perfRobot || selectedCharacter !== 'default') ? '' : 'none'; },
      setPulse(value) { softOrb.settings({ orbPulse: value }); },
      setHeartbeat(value) { softOrb.settings({ orbHeartbeat: value }); },
      setPulseStrength(value) { softOrb.settings({ orbPulseStrength: value }); },
      setPulseSpeed(value) { softOrb.settings({ orbPulseSpeed: value }); },
      pulseHeart() { softOrb.pulse(); },
      applyAppearance(payload = {}, { keepSize = false } = {}) { const read = (key, fallback) => payload[key] ?? localStorage.getItem(key) ?? fallback; this.setCharacter(read('orbTheme', 'default')); perfMode(read('orbAvatarMode', 'orb')); robotHead.settings(read('robotHeadOptions', '{}')); softOrb.settings(Object.fromEntries(['orbPulse', 'orbHeartbeat', 'orbPulseStrength', 'orbPulseSpeed'].map(key => [key, read(key, key === 'orbHeartbeat' ? true : 100)]))); if (!keepSize) this.setSize(Number(read('orbSize', 116))); },
      accentPalette: () => defaultOrbColors(),
      ACCENT_THEME: 'accent',
      GLASS_TYPES: {},
      get DEFAULT_COLORS() { return defaultOrbColors(); },
      __perfMode: true,
    }, {
      get: (target, key) => (key in target ? target[key] : noop),
    });
    return;
  }

  // Palette par défaut : pastels en édition standard, or en édition Pro
  // (cf. lib/orb-palette.js — un seul endroit pour ces deux jeux de couleurs).
  const DEFAULT_COLORS_FN = () => defaultOrbColors();
  const ACCENT_THEME = 'accent'; // API héritée, résolue vers Original.

  function readColors() {
    try {
      const c = JSON.parse(localStorage.getItem('orbColors'));
      if (Array.isArray(c) && c.length === 5) return c;
    } catch (e) {}
    return DEFAULT_COLORS_FN();
  }
  let orbEnabled = localStorage.getItem('orbEnabled') !== 'false';
  let orbSize = parseInt(localStorage.getItem('orbSize') || '116', 10);
  // Inner colored sphere size, as a % of the glass shell. Lower = smaller core =
  // bigger gap to the shell = "thicker" looking glass. 82 keeps the original look.
  let orbCoreScale = parseInt(localStorage.getItem('orbCoreScale') || '82', 10);
  // The core geometry has radius 0.82, so a value of 82 maps to scale 1.0.
  let coreBaseScale = (orbCoreScale / 100) / 0.82;
  let orbGlassType = localStorage.getItem('orbGlassType') || 'thin';
  // Pulsation amplitude during speech synthesis. Stored as a percentage
  // (100 = default); used as a 0–2.5 multiplier on the speaking "breath".
  let orbPulse = parseFloat(localStorage.getItem('orbPulse') || '100') / 100;
  // Radial pulse rippling across the sphere when a Heartbeat fires.
  let orbHeartbeat = localStorage.getItem('orbHeartbeat') !== 'false';
  let orbPulseColor = localStorage.getItem('orbHeartColor') || '#ff4d6d';
  // Strength (0..2 multiplier) and speed (duration in s = 1.6 * 100/speed%).
  let orbPulseStrength = parseFloat(localStorage.getItem('orbPulseStrength') || '100') / 100;
  let orbPulseSpeed = parseFloat(localStorage.getItem('orbPulseSpeed') || '100') / 100;

  // ---- Bouche animée (option) ---------------------------------------------
  //
  // Une barre horizontale taillée comme les yeux, qui s'ouvre au rythme de la
  // voix. Elle est créée ICI et non dans le HTML : les quatre surfaces qui
  // affichent l'orbe (barre, bureau, compagnon, compagnon IA) l'obtiennent sans
  // qu'on touche à leur balisage, et ses dimensions suivent la taille de l'orbe
  // au lieu d'être recopiées dans quatre feuilles de style.
  //
  // Le niveau vient, par ordre de préférence :
  //   1. de l'enveloppe RÉELLE de la voix, calculée par le backend sur le WAV
  //      qu'il s'apprête à lire et envoyée avec l'événement `tts-playing` ;
  //   2. à défaut (voix système, Raccourcis macOS : aucun échantillon
  //      disponible), de l'enveloppe synthétique qui anime déjà le cœur.
  let orbMouth = localStorage.getItem('orbMouth') === 'true';
  let mouthEl = null;
  let mouthLevel = 0;
  let voiceEnvelopeData = null;
  let voiceEnvelopeFrameMs = 40;
  let voiceEnvelopeStart = 0;

  let mouthBase = null;
  function layoutMouth() {
    if (!mouthEl) return;
    // La bouche se cale sur les yeux réellement affichés (leur taille vient du
    // CSS de chaque surface et ne suit pas le diamètre de l'orbe), avec un repli
    // proportionnel quand ils ne sont pas encore mesurables.
    const eye = eyesEl?.querySelector('span');
    const box = eye ? { width: eye.offsetWidth, height: eye.offsetHeight } : null;
    const size = box && box.width > 0
      ? mouthSizeFromEye(box)
      : {
          width: Math.max(8, Math.round(orbSize * MOUTH_FALLBACK.width)),
          height: Math.max(3, Math.round(orbSize * MOUTH_FALLBACK.height)),
          offsetY: Math.round(orbSize * MOUTH_FALLBACK.offsetY),
        };
    // Centre de la bouche, mémorisé : l'animation change sa taille autour de
    // ce point au lieu de l'étirer (un scale() écrasait ses bouts arrondis).
    mouthBase = { width: size.width, height: size.height, centerY: orbSize / 2 - 4 + size.offsetY };
    Object.assign(mouthEl.style, {
      width: `${size.width}px`,
      height: `${size.height}px`,
      marginLeft: `${-size.width / 2}px`,
      // Les yeux sont remontés de 4 px par leur CSS : la bouche part du même axe.
      top: `${Math.round(mouthBase.centerY - size.height / 2)}px`,
      boxShadow: `0 0 ${Math.max(3, Math.round(size.height * 0.9))}px rgba(255, 255, 255, 0.8)`,
    });
  }

  function ensureMouth() {
    if (mouthEl) return;
    mouthEl = document.createElement('div');
    mouthEl.className = 'orb-mouth';
    mouthEl.setAttribute('aria-hidden', 'true');
    Object.assign(mouthEl.style, {
      position: 'absolute', left: '50%', zIndex: '2',
      borderRadius: '99px', background: '#ffffff',
      pointerEvents: 'none', transformOrigin: 'center', opacity: '0',
    });
    container.appendChild(mouthEl);
    layoutMouth();
  }

  function setMouth(on) {
    orbMouth = !!on;
    if (orbMouth) ensureMouth();
    if (mouthEl) mouthEl.style.display = orbMouth ? '' : 'none';
  }

  /// Niveau de bouche à cet instant : 0 = fermée, 1 = grande ouverte.
  function mouthLevelNow(t) {
    if (voiceEnvelopeData) {
      const level = envelopeLevel(
        voiceEnvelopeData, voiceEnvelopeFrameMs, performance.now() - voiceEnvelopeStart);
      if (level != null) return level;
      voiceEnvelopeData = null;   // lecture terminée
    }
    return state === 'speaking' ? syntheticLevel(t) * 0.92 : 0;
  }

  /**
   * Rejoue une enveloppe de voix sur la bouche. `payload` = { envelope, frame_ms }
   * — un niveau 0–255 par tranche de `frame_ms`. Passer une valeur vide coupe
   * l'enveloppe et rend la main à l'animation synthétique.
   */
  function playVoiceEnvelope(payload) {
    const data = Array.isArray(payload?.envelope) ? payload.envelope : null;
    if (!data || !data.length) { voiceEnvelopeData = null; return; }
    voiceEnvelopeData = data;
    voiceEnvelopeFrameMs = Number(payload.frame_ms) || 40;
    voiceEnvelopeStart = performance.now();
  }

  // Enveloppe réelle : le backend l'émet au moment où le son démarre, ce qui
  // permet d'aligner l'ouverture de la bouche sur la voix et non sur le début
  // de la synthèse. Sans Tauri (page de démonstration du site), rien à écouter.
  {
    const evt = window.__TAURI__?.event;
    evt?.listen?.('tts-playing', (event) => playVoiceEnvelope(event?.payload));
    const clear = () => { voiceEnvelopeData = null; };
    evt?.listen?.('tts-ended', clear);
    evt?.listen?.('tts-error', clear);
  }

  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: true, antialias: true, premultipliedAlpha: false,
  });
  renderer.setClearColor(0x000000, 0);
  // Plafond réglable par la page hôte (une page à grand orbe peut l'abaisser : grande
  // orbe + llama.cpp sur le même GPU).
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.__lumenOrbMaxDpr || 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 3.4);

  // ---- Avatar GLB personnalisé ------------------------------------------
  // Contrat Blender ↔ Lumen. Les clips sont validés par le backend à
  // l'import ; ici on ne fait que relier la machine d'états au bon clip.
  const CUSTOM_CLIPS = {
    idle: 'Lumen_Idle',
    thinking: 'Lumen_Thinking',
    speaking: 'Lumen_Speaking',
    action: 'Lumen_Action',
    heartbeat: 'Lumen_Heartbeat',
  };
  const gltfLoader = new GLTFLoader();
  const customAvatarGroup = new THREE.Group();
  scene.add(customAvatarGroup);
  const customAmbientLight = new THREE.HemisphereLight(0xffffff, 0x445066, 0.8);
  scene.add(customAmbientLight);
  const customKeyLight = new THREE.DirectionalLight(0xffffff, 1.35);
  customKeyLight.position.set(2.5, 3.5, 4);
  scene.add(customKeyLight);
  const customRimLight = new THREE.DirectionalLight(0x7aa7ff, 0.55);
  customRimLight.position.set(-3, 1, -2);
  scene.add(customRimLight);
  let avatarMode = localStorage.getItem('orbAvatarMode') || 'orb';
  let customAvatar = null;
  let customMixer = null;
  let customActions = new Map();
  let customAction = null;
  let customLoadGeneration = 0;
  function ambientCoefficient(value) {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return 1;
    // Migration des anciennes valeurs en pourcentage (100 → 1.0).
    return Math.max(0, Math.min(8, raw > 10 ? raw / 100 : raw));
  }
  let customAmbientCoefficient = ambientCoefficient(localStorage.getItem('avatarGlbAmbientLight') || '1');

  function setCustomAmbientLight(pct) {
    customAmbientCoefficient = ambientCoefficient(pct);
    customAmbientLight.intensity = customAmbientCoefficient;
  }
  // Initialise l’éclairage GLB avec le coefficient migré (et non l’ancien
  // nom de variable en pourcentage, qui empêchait orb.js de démarrer).
  setCustomAmbientLight(customAmbientCoefficient);

  function tauriInvoke() {
    try {
      return window.__TAURI__?.core?.invoke
        || (window.parent !== window ? window.parent.__TAURI__?.core?.invoke : null);
    } catch (_) { return null; }
  }

  function base64ToArrayBuffer(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function disposeCustomAvatar() {
    customMixer?.stopAllAction();
    if (customAvatar) {
      customAvatar.traverse((node) => {
        node.geometry?.dispose?.();
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.filter(Boolean).forEach((material) => {
          Object.values(material).forEach((value) => value?.isTexture && value.dispose());
          material.dispose?.();
        });
      });
      customAvatarGroup.remove(customAvatar);
    }
    customAvatar = null;
    customMixer = null;
    customActions = new Map();
    customAction = null;
  }

  function showBuiltinAvatar(show) {
    core.visible = show;
    shell.visible = show;
    iconGroup.visible = show;
    if (eyesEl) eyesEl.style.visibility = show ? '' : 'hidden';
    if (mouthEl) mouthEl.style.visibility = show ? '' : 'hidden';
    if (frostEl) frostEl.style.display = show ? '' : 'none';
    if (shadowEl) shadowEl.style.display = show ? '' : 'none';
    if (ambientGlowEl) ambientGlowEl.style.display = show ? '' : 'none';
    container.dataset.avatarMode = show ? 'orb' : avatarMode;
    if (orbWrap) orbWrap.dataset.avatarMode = show ? 'orb' : avatarMode;
    document.body.classList.toggle('avatar-custom', !show);
    customAmbientLight.visible = !show;
    customKeyLight.visible = !show;
    customRimLight.visible = !show;
    if (show) container.style.removeProperty('--orb-bob');
    else container.style.setProperty('--orb-bob', '0px');
    customAvatarGroup.visible = !show && !!customAvatar;
  }

  function playCustomClip(name, { once = false } = {}) {
    const next = customActions.get(name);
    if (!next || next === customAction) return;
    next.enabled = true;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once;
    next.fadeIn(0.22).play();
    if (customAction) customAction.fadeOut(0.22);
    customAction = next;
  }

  function fitCustomAvatar(object) {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) throw new Error('Le GLB ne contient aucun objet 3D visible.');
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const largest = Math.max(size.x, size.y, size.z);
    const scale = 1.8 / Math.max(largest, 0.001);
    object.scale.setScalar(scale);
    object.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
  }

  async function loadCustomAvatar() {
    const invoke = tauriInvoke();
    if (!invoke) return false;
    const generation = ++customLoadGeneration;
    try {
      const payload = await invoke('avatar_glb_load');
      if (generation !== customLoadGeneration || !payload?.data) return false;
      const gltf = await new Promise((resolve, reject) => {
        gltfLoader.parse(base64ToArrayBuffer(payload.data), '', resolve, reject);
      });
      if (generation !== customLoadGeneration) return false;
      disposeCustomAvatar();
      customAvatar = gltf.scene;
      fitCustomAvatar(customAvatar);
      customAvatarGroup.add(customAvatar);
      customMixer = new THREE.AnimationMixer(customAvatar);
      customActions = new Map(gltf.animations.map((clip) => [clip.name, customMixer.clipAction(clip)]));
      showBuiltinAvatar(false);
      playCustomClip(actionExecuting ? CUSTOM_CLIPS.action : CUSTOM_CLIPS[state]);
      return true;
    } catch (error) {
      console.warn('Avatar GLB Lumen indisponible :', error);
      avatarMode = 'orb';
      showBuiltinAvatar(true);
      return false;
    }
  }

  function setAvatarMode(mode) {
    const nextMode = ['custom', 'robot-head'].includes(mode) ? mode : 'orb';
    const changed = nextMode !== avatarMode;
    avatarMode = nextMode;
    robotHead.setActive(avatarMode === 'robot-head');
    canvas.style.display = avatarMode === 'robot-head' ? 'none' : '';
    if (avatarMode === 'robot-head') {
      customLoadGeneration += 1;
      softOrb.apply('default');
      showBuiltinAvatar(false);
      customAvatarGroup.visible = false;
      queueMicrotask(stop);
    } else if (avatarMode === 'custom') {
      if (changed || !customAvatar) loadCustomAvatar();
      else showBuiltinAvatar(false);
    }
    else {
      customLoadGeneration += 1;
      softOrb.apply(selectedCharacter);
      showBuiltinAvatar(true);
    }
    queueMicrotask(() => { if (avatarMode !== 'robot-head' && orbEnabled && !document.hidden) start(); });
  }

  // ---- Color core ----
  const { coreUniforms, coreMat, shellUniforms, shellMat, GLASS_TYPES } = createOrbMaterials(readColors(), orbPulseColor);
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.82, 64, 64), coreMat);
  scene.add(core);

  // ---- Glass shell (parameterized: several glass "types") ----
  // Each glass type is just a set of rim/specular/fill parameters fed to the
  // shader, so switching is instant and animation-friendly.
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1.0, 64, 64), shellMat);
  shell.renderOrder = 1;
  scene.add(shell);

  function setGlassType(name) {
    const g = GLASS_TYPES[name] || GLASS_TYPES.thin;
    orbGlassType = GLASS_TYPES[name] ? name : 'thin';
    shellUniforms.uOpacity.value = g.opacity;
    shellUniforms.uRimPower.value = g.rimPower;
    shellUniforms.uRimStrength.value = g.rimStrength;
    shellUniforms.uSpecPower.value = g.specPower;
    shellUniforms.uSpecStrength.value = g.specStrength;
    shellUniforms.uFill.value = g.fill;
    shellUniforms.uIridescence.value = g.iridescence;
  }
  setGlassType(orbGlassType);

  // ---- Inner mini-icons (themed avatars) ----------------------------------
  // Small white symbols orbiting *inside* the glass shell. Used by themes
  // (e.g. "rubis"). Drawn on a tiny canvas → CanvasTexture → camera-facing
  // Sprite, parented to a group we spin in animate(). Empty by default, so the
  // classic orb is untouched unless a theme asks for icons.
  const iconGroup = new THREE.Group();
  iconGroup.renderOrder = 2;
  scene.add(iconGroup);

  // Each painter draws a centered white glyph on a 2D context (64×64).
  const ICON_PAINTERS = {
    sphere(c, s) {
      const g = c.createRadialGradient(s * 0.38, s * 0.36, s * 0.04, s * 0.5, s * 0.5, s * 0.46);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0.55)');
      c.fillStyle = g;
      c.beginPath(); c.arc(s * 0.5, s * 0.5, s * 0.42, 0, Math.PI * 2); c.fill();
    },
    star(c, s) {
      c.fillStyle = '#fff'; c.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? s * 0.18 : s * 0.45;
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const x = s * 0.5 + Math.cos(a) * r, y = s * 0.5 + Math.sin(a) * r;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.closePath(); c.fill();
    },
    moon(c, s) {
      c.fillStyle = '#fff';
      c.beginPath(); c.arc(s * 0.5, s * 0.5, s * 0.42, 0, Math.PI * 2); c.fill();
      c.globalCompositeOperation = 'destination-out';
      c.beginPath(); c.arc(s * 0.62, s * 0.44, s * 0.36, 0, Math.PI * 2); c.fill();
      c.globalCompositeOperation = 'source-over';
    },
    heart(c, s) {
      c.fillStyle = '#fff'; c.beginPath();
      const x = s * 0.5, y = s * 0.34, w = s * 0.42, h = s * 0.40;
      c.moveTo(x, y + h * 0.28);
      c.bezierCurveTo(x + w * 0.5, y - h * 0.45, x + w * 1.1, y + h * 0.45, x, y + h * 1.1);
      c.bezierCurveTo(x - w * 1.1, y + h * 0.45, x - w * 0.5, y - h * 0.45, x, y + h * 0.28);
      c.fill();
    },
    bolt(c, s) {
      c.fillStyle = '#fff'; c.beginPath();
      c.moveTo(s * 0.56, s * 0.08); c.lineTo(s * 0.30, s * 0.54); c.lineTo(s * 0.47, s * 0.54);
      c.lineTo(s * 0.42, s * 0.92); c.lineTo(s * 0.70, s * 0.42); c.lineTo(s * 0.52, s * 0.42);
      c.closePath(); c.fill();
    },
    diamond(c, s) {
      c.fillStyle = '#fff'; c.beginPath();
      c.moveTo(s * 0.5, s * 0.1); c.lineTo(s * 0.88, s * 0.5);
      c.lineTo(s * 0.5, s * 0.9); c.lineTo(s * 0.12, s * 0.5);
      c.closePath(); c.fill();
    },
  };

  function makeIconTexture(name, hex) {
    const s = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const ctx = cv.getContext('2d');
    (ICON_PAINTERS[name] || ICON_PAINTERS.sphere)(ctx, s);
    if (hex && hex !== '#ffffff') {
      // Tint the white glyph by multiplying with the theme color.
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = hex;
      ctx.fillRect(0, 0, s, s);
      ctx.globalCompositeOperation = 'source-over';
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function clearInnerIcons() {
    for (let i = iconGroup.children.length - 1; i >= 0; i--) {
      const sp = iconGroup.children[i];
      iconGroup.remove(sp);
      if (sp.material) { sp.material.map?.dispose(); sp.material.dispose(); }
    }
  }

  // list: array of icon names (or empty/null to clear). color: optional hex.
  function setInnerIcons(list, color) {
    clearInnerIcons();
    if (!Array.isArray(list) || list.length === 0) return;
    const n = list.length;
    const ring = 0.46;       // orbit radius (inside the 0.82 core)
    list.forEach((name, i) => {
      const tex = makeIconTexture(name, color || '#ffffff');
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: false,
        opacity: 0.95,
      });
      const sp = new THREE.Sprite(mat);
      const a = (i / n) * Math.PI * 2;
      // Distribute on a tilted ring for a 3D "orbiting inside" feel.
      sp.position.set(Math.cos(a) * ring, Math.sin(a) * ring * 0.55, Math.sin(a) * ring * 0.7);
      sp.scale.setScalar(0.30);
      iconGroup.add(sp);
    });
  }

  // ---- Sizing ----
  function applySize(px) {
    orbSize = px;
    document.documentElement.style.setProperty('--orb-preferred-size', `${px}px`);
    container.style.width = px + 'px';
    container.style.height = px + 'px';
    layoutMouth();
    if (orbWrap) orbWrap.style.height = (px + 12) + 'px';
    resize();
  }
  function resize() {
    const w = container.clientWidth || 116;
    const h = container.clientHeight || 116;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  applySize(orbSize);
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(container);

  // ---- State machine ----
  let state = 'idle';
  const targets = { speed: 0.30, intensity: 1.0 };
  function setState(next) {
    state = next;
    // Lumen se met au travail : l'orbe se réveille (micro-tâche : `mood` est
    // déclaré plus bas dans le module).
    if (next !== 'idle') queueMicrotask(() => { if (mood === 'sleep') setMood(''); lastActivity = Date.now(); });
    if (next === 'thinking') { targets.speed = 1.1; targets.intensity = 1.12; }
    else if (next === 'speaking') { targets.speed = 0.7; targets.intensity = 1.18; }
    else { targets.speed = 0.30; targets.intensity = 1.0; }
    container.dataset.state = next;
    if (avatarMode === 'custom' && !actionExecuting) playCustomClip(CUSTOM_CLIPS[next] || CUSTOM_CLIPS.idle);
    try { window.OrbBridge && window.OrbBridge.pushMode(next); } catch (e) {}
  }

  // The amber/"lightning" color of the Action-mode toolbar button. While the
  // router runs a tool/action, all blobs flip to this so the user sees the orb
  // is *executing*, not merely thinking.
  const ACTION_COLOR = '#ff9e6b';
  let activePalette = readColors();   // the user's configured palette
  let actionExecuting = false;

  function applyPalette(arr) {
    coreUniforms.uCol0.value.set(arr[0]);
    coreUniforms.uCol1.value.set(arr[1]);
    coreUniforms.uCol2.value.set(arr[2]);
    coreUniforms.uCol3.value.set(arr[3]);
    coreUniforms.uCol4.value.set(arr[4]);
  }

  function setColors(hexArray) {
    if (!Array.isArray(hexArray) || hexArray.length !== 5) return;
    activePalette = hexArray.slice();
    // Don't override the action color while a tool is running; the palette is
    // restored automatically when execution ends.
    if (!actionExecuting) applyPalette(activePalette);
  }

  // Flip every blob to the action color (and energize the motion) while the
  // router executes; restore the user's palette + current state when it ends.
  function setActionExecuting(on) {
    on = !!on;
    if (on === actionExecuting) return;
    actionExecuting = on;
    if (on) {
      applyPalette([ACTION_COLOR, ACTION_COLOR, ACTION_COLOR, ACTION_COLOR, ACTION_COLOR]);
      container.dataset.action = 'executing';
      targets.speed = 1.35;
      targets.intensity = 1.28;
      if (avatarMode === 'custom') playCustomClip(CUSTOM_CLIPS.action);
    } else {
      applyPalette(activePalette);
      delete container.dataset.action;
      setState(state); // re-derive speed/intensity for the current state
    }
  }

  function setSize(px) { applySize(px); }

  function setCoreScale(pct) {
    orbCoreScale = pct;
    coreBaseScale = (pct / 100) / 0.82;
  }

  function setPulse(pct) { orbPulse = pct / 100; softOrb.settings({ orbPulse: pct }); }

  function setHeartbeat(on) { orbHeartbeat = !!on; softOrb.settings({ orbHeartbeat: on }); }
  function setHeartColor(hex) {
    if (typeof hex !== 'string') return;
    orbPulseColor = hex;
    coreUniforms.uPulseColor.value.set(hex);
  }
  function setPulseStrength(pct) { orbPulseStrength = pct / 100; softOrb.settings({ orbPulseStrength: pct }); }
  function setPulseSpeed(pct) { orbPulseSpeed = Math.max(pct, 10) / 100; softOrb.settings({ orbPulseSpeed: pct }); }

  // ---- Radial heartbeat pulse (a colored ring rippling across the sphere) ----
  let pulseActive = false;
  let pulseStart = 0;
  function pulseDuration() { return 1.6 / orbPulseSpeed; }
  function pulseHeart() {
    if (!orbHeartbeat || !orbEnabled) return;
    if (selectedCharacter !== 'default') { softOrb.pulse(); return; }
    if (avatarMode === 'custom' && customActions.has(CUSTOM_CLIPS.heartbeat)) {
      playCustomClip(CUSTOM_CLIPS.heartbeat, { once: true });
      const duration = customActions.get(CUSTOM_CLIPS.heartbeat).getClip().duration || 1;
      window.setTimeout(() => {
        if (avatarMode === 'custom') playCustomClip(actionExecuting ? CUSTOM_CLIPS.action : CUSTOM_CLIPS[state]);
      }, duration * 1000);
      return;
    }
    pulseStart = clock.elapsedTime;
    pulseActive = true;
  }

  function setEnabled(on) {
    orbEnabled = on;
    robotHead.setEnabled(on);
    container.dataset.softDisabled = String(!on);
    if (orbWrap) orbWrap.style.display = on ? '' : 'none';
    if (on) { resize(); start(); } else { stop(); }
  }

  /** OKLCH (L 0..1, C, H degrés) → « #rrggbb ». Conversion de référence Oklab. */
  function oklchToHex(L, C, H) {
    const h = (H * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return '#' + [r, g, bl].map((v) => srgbFromLinear(v).toString(16).padStart(2, '0')).join('');
  }

  /**
   * Lit la couleur d'action courante et la ramène en OKLCH. Les jetons sont
   * écrits `oklch(L C H)` ; un thème qui poserait un hexadécimal reste accepté
   * (repli par un canvas). Renvoie null si rien n'est lisible — l'appelant
   * garde alors la palette de l'utilisateur.
   */
  function readAccentOklch() {
    let raw = '';
    try {
      raw = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    } catch (e) { return null; }
    if (!raw) return null;
    const oklch = raw.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/i);
    if (oklch) {
      const L = oklch[1].endsWith('%') ? parseFloat(oklch[1]) / 100 : parseFloat(oklch[1]);
      return { L, C: parseFloat(oklch[2]), H: parseFloat(oklch[3]) };
    }
    const hex = raw.match(/^#([0-9a-f]{6})$/i);
    if (!hex) return null;
    // Chemin de repli : on ne convertit pas en sens inverse, la teinte est
    // utilisée telle quelle pour les cinq stops (variation par luminosité).
    return { hex: raw };
  }

  /**
   * Cinq couleurs autour de l'accent : mêmes variations de clarté et de teinte
   * que les palettes pastel de l'orbe, mais construites depuis la couleur de
   * l'interface. Renvoie null si l'accent n'est pas lisible.
   */
  function accentPalette() {
    const base = readAccentOklch();
    if (!base) return null;
    if (base.hex) return [base.hex, base.hex, base.hex, base.hex, base.hex];
    const steps = [
      { dl: 0.06, dh: -16 },
      { dl: -0.04, dh: -8 },
      { dl: 0.00, dh: 0 },
      { dl: -0.08, dh: 10 },
      { dl: 0.10, dh: 18 },
    ];
    return steps.map(({ dl, dh }) => oklchToHex(
      Math.max(0.25, Math.min(0.95, base.L + dl)),
      base.C,
      (base.H + dh + 360) % 360,
    ));
  }

  // Applique l'apparence de l'avatar (thème compris) depuis un payload de
  // réglages (settings-draft/updated) avec repli sur localStorage. `keepSize`
  // laisse la taille intacte (le bureau gère la sienne, par sandbox). La
  // visibilité (orbEnabled) reste pilotée par chaque fenêtre.
  function applyAppearance(payload = {}, { keepSize = false } = {}) {
    const read = (k, d) => (payload[k] != null ? String(payload[k]) : (localStorage.getItem(k) ?? d));
    const themeId = characterId(read('orbTheme', 'default'));
    setCharacter(themeId);
    // « accent » n'est pas un thème figé : sa palette est recalculée à chaque
    // application, donc elle suit la couleur d'apparence sans être stockée.
    let colors = null;
    try {
      const c = JSON.parse(read('orbColors', 'null'));
      if (Array.isArray(c) && c.length === 5) colors = c;
    } catch (e) {}
    setColors(colors || DEFAULT_COLORS_FN());
    // L'accent ne dicte que les couleurs : le verre reste celui de
    // l'utilisateur, sinon changer d'accent lui reprendrait un réglage à lui.
    setGlassType(read('orbGlassType', 'thin'));
    setHeartColor(read('orbHeartColor', '#ff4d6d'));
    setCoreScale(parseInt(read('orbCoreScale', '82'), 10) || 82);
    setPulse(Number(read('orbPulse', '100')));
    setHeartbeat(read('orbHeartbeat', 'true') !== 'false');
    setPulseStrength(parseFloat(read('orbPulseStrength', '100')) || 100);
    setPulseSpeed(parseFloat(read('orbPulseSpeed', '100')) || 100);
    setCustomAmbientLight(read('avatarGlbAmbientLight', '1'));
    setMouth(read('orbMouth', 'false') === 'true');
    if (!keepSize) setSize(parseInt(read('orbSize', '116'), 10) || 116);
    robotHead.settings(read('robotHeadOptions', '{}'));
    setAvatarMode(read('orbAvatarMode', 'orb') === 'robot-head' ? 'robot-head' : selectedCharacter === 'default' ? read('orbAvatarMode', 'orb') : 'orb');
    try { window.OrbBridge && window.OrbBridge.pushTheme(read('orbTheme', 'default')); } catch (e) {}
  }
  // À l'init, honore aussi `orbTheme` (avant, seul main.js l'appliquait : les
  // autres fenêtres — bureau — ne voyaient que la palette personnalisée).
  applyAppearance({}, { keepSize: true });

  // ---- Personnalité : humeurs, toucher, sommeil, tenues ----------------------
  //
  // L'orbe n'est plus seulement un indicateur d'état : elle RÉAGIT. Une humeur
  // (`setMood`) change la forme des yeux, fait éclore une petite bulle
  // d'émotion et teinte brièvement le cœur :
  //   joy (tâche réussie) · sad (erreur) · ask (Lumen attend ta réponse)
  //   · sleep (inactivité) · surprised (clic) · dizzy (trop de clics) · love.
  // Tout est en CSS injecté ici (et non dans styles.css) pour que les quatre
  // surfaces qui affichent l'orbe en profitent sans toucher à leur balisage.
  // Réglages : `orbMoods` ("false" = coupé).
  let moodsOn = localStorage.getItem('orbMoods') !== 'false';
  softOrb.settings({ orbMoods: moodsOn });
  let mood = '';
  let moodTimer = 0;
  let tintTimer = 0;
  let emoteEl = null;

  (function injectMoodCss() {
    if (document.getElementById('orb-mood-css')) return;
    const st = document.createElement('style');
    st.id = 'orb-mood-css';
    st.textContent = `
.orb-container { transition: scale .5s cubic-bezier(.3,1.7,.45,1); }
.orb-container.orb-squish { scale: 1.13 .86; transition: scale .09s ease-out; }
.orb-container.orb-hover { scale: 1.035; }
.orb-container .orb-eyes span { transition: height .22s cubic-bezier(.3,1.5,.5,1), width .22s ease, border-radius .22s ease, rotate .25s ease, translate .25s ease, opacity .3s ease; }
/* Échelle des expressions : tout dérive de l'œil de base de la surface
   (--eye-w = E, --eye-h = H, posés par chaque feuille de style). Un seul
   trait S = 0,75 E pour les arcs, l'œil fermé, le sommeil et l'étourdi — la
   bouche fermée a la même épaisseur (voice-mouth.js). Ainsi les expressions
   gardent les mêmes proportions de la barre (7 × 22) à Luciole (5 × 15). */
.orb-eyes { --E: var(--eye-w, 7px); --H: var(--eye-h, 22px); --S: calc(var(--E) * .75); }
.orb-container[data-mood="joy"] .orb-eyes span { box-sizing: border-box; width: calc(var(--E) * 2.4); height: calc(var(--E) * 1.3); background: transparent; border: var(--S) solid #fff; border-bottom: 0; border-radius: 99px 99px 0 0; box-shadow: none; filter: drop-shadow(0 0 4px rgba(255,255,255,.85)); animation: none; translate: 0 calc(var(--E) * -.4); position: relative; }
/* Embouts ronds : l'arc est une bordure, coupée net à ses extrémités ; deux
   pastilles de son épaisseur lui rendent l'arrondi des yeux de base. */
.orb-container[data-mood="joy"] .orb-eyes span::before, .orb-container[data-mood="joy"] .orb-eyes span::after { content: ""; position: absolute; bottom: calc(var(--S) / -2); left: calc(var(--S) * -1); width: var(--S); height: var(--S); border-radius: 50%; background: #fff; }
.orb-container[data-mood="joy"] .orb-eyes span::after { left: auto; right: calc(var(--S) * -1); }
.orb-container[data-mood="love"] .orb-eyes span { height: calc(var(--E) * 1.7); width: calc(var(--E) * 1.7); border-radius: 50%; animation: orbLove .7s ease-in-out infinite alternate; }
.orb-container[data-mood="sad"] .orb-eyes span { height: calc(var(--H) * .5); translate: 0 calc(var(--E) * .6); animation: none; }
.orb-container[data-mood="sad"] .orb-eyes span:first-child { rotate: -22deg; }
.orb-container[data-mood="sad"] .orb-eyes span:last-child { rotate: 22deg; }
.orb-container[data-mood="ask"] .orb-eyes span:first-child { height: calc(var(--H) * .64); translate: 0 calc(var(--E) * .45); }
.orb-container[data-mood="ask"] .orb-eyes span:last-child { height: calc(var(--H) * 1.14); }
.orb-container[data-mood="sleep"] .orb-eyes span { height: var(--S); width: calc(var(--E) * 2); translate: 0 calc(var(--E) * .7); animation: none; opacity: .85; }
.orb-container[data-mood="surprised"] .orb-eyes span { height: calc(var(--E) * 1.9); width: calc(var(--E) * 1.9); border-radius: 50%; animation: none; }
.orb-container[data-mood="dizzy"] .orb-eyes span { box-sizing: content-box; height: calc(var(--E) * .9); width: calc(var(--E) * .9); border-radius: 50%; background: transparent; border: var(--S) solid #fff; border-right-color: transparent; box-shadow: none; animation: orbDizzy .55s linear infinite; position: relative; }
/* Étourdi : l'arc s'arrête à ±45° (bordure droite transparente). Pastilles
   centrées sur le milieu du trait à ces angles : centre 0,45 E, rayon du
   trait 0,825 E → décalage 0,583 E, moins la demi-épaisseur 0,375 E. */
.orb-container[data-mood="dizzy"] .orb-eyes span::before, .orb-container[data-mood="dizzy"] .orb-eyes span::after { content: ""; position: absolute; left: calc(var(--E) * .658); top: calc(var(--E) * -.508); width: var(--S); height: var(--S); border-radius: 50%; background: #fff; }
.orb-container[data-mood="dizzy"] .orb-eyes span::after { top: calc(var(--E) * .658); }
.orb-container[data-mood="dizzy"] { animation: orbWobble .5s ease-in-out infinite alternate; }
.orb-container[data-night="1"]:not([data-mood]) .orb-eyes span { height: calc(var(--H) * .77); opacity: .9; }
@keyframes orbDizzy { to { rotate: 360deg; } }
@keyframes orbWobble { from { rotate: -7deg; } to { rotate: 7deg; } }
@keyframes orbLove { to { scale: 1.25; } }
.orb-emote { position: absolute; right: 2%; top: 4%; z-index: 4; min-width: 24px; height: 24px; padding: 0 6px; border-radius: 12px 12px 12px 3px;
  display: grid; place-items: center; font: 700 13px/1 "Outfit", system-ui, sans-serif; color: #1d1d1f; background: #fff;
  box-shadow: 0 4px 14px rgba(0,0,0,.18); pointer-events: none; opacity: 0; scale: .3; translate: -6px 8px;
  transition: opacity .2s ease, scale .35s cubic-bezier(.3,1.7,.45,1), translate .35s cubic-bezier(.3,1.7,.45,1); }
.orb-emote.on { opacity: 1; scale: 1; translate: 0 0; }
.orb-emote.zz { background: transparent; box-shadow: none; color: #fff; text-shadow: 0 0 6px rgba(0,0,0,.35); animation: orbZz 2.4s ease-in-out infinite; }
@keyframes orbZz { 0% { translate: 0 6px; opacity: 0; } 30% { opacity: 1; } 100% { translate: 10px -14px; opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .orb-container, .orb-container * { animation-duration: 0s !important; transition-duration: 0s !important; }
}`;
    document.head.appendChild(st);
  })();

  // Bulle d'émotion (« ! », « ? », « zz », ✓…) au-dessus de l'orbe.
  function emote(text, ms = 1600, cls = '') {
    if (!emoteEl) {
      emoteEl = document.createElement('div');
      emoteEl.className = 'orb-emote';
      emoteEl.setAttribute('aria-hidden', 'true');
      container.appendChild(emoteEl);
    }
    clearTimeout(emoteEl._t);
    emoteEl.className = `orb-emote ${cls}`;
    emoteEl.textContent = text;
    void emoteEl.offsetWidth;
    emoteEl.classList.add('on');
    if (ms > 0) emoteEl._t = setTimeout(() => emoteEl.classList.remove('on'), ms);
  }
  function hideEmote() { if (emoteEl) { clearTimeout(emoteEl._t); emoteEl.classList.remove('on'); } }

  // Teinte passagère du cœur : la palette se mélange à la couleur d'humeur,
  // puis revient. Jamais pendant une action (qui a sa propre couleur).
  const MOOD_TINT = { joy: '#34d399', sad: '#fb7185', ask: '#fbbf24', love: '#f472b6' };
  function tint(hex, ms) {
    if (!hex || actionExecuting) return;
    clearTimeout(tintTimer);
    const c = new THREE.Color(hex);
    applyPalette(activePalette.map((h, i) => '#' + new THREE.Color(h).lerp(c, i % 2 ? 0.45 : 0.65).getHexString()));
    if (ms > 0) tintTimer = setTimeout(() => { if (!actionExecuting) applyPalette(activePalette); }, ms);
  }
  function untint() { clearTimeout(tintTimer); if (!actionExecuting) applyPalette(activePalette); }

  const MOOD_EMOTE = { joy: '✓', sad: '!', ask: '?', love: '♥', surprised: '!', dizzy: '@' };
  const MOOD_SOUND = { joy: 'joy', sad: 'error', ask: 'ask', sleep: 'sleep', dizzy: 'dizzy', love: 'joy' };
  /**
   * Humeur passagère (ms > 0) ou tenue (ms = 0, jusqu'au prochain setMood).
   * `quiet` : sans son (l'appelant joue déjà le sien).
   */
  function setMood(next, { ms = 2200, quiet = false, emoteText } = {}) {
    if (!moodsOn && next !== '') return;
    clearTimeout(moodTimer);
    const prev = mood;
    mood = next || '';
    if (mood) container.dataset.mood = mood; else delete container.dataset.mood;
    if (!mood) { hideEmote(); untint(); return; }
    if (mood === 'sleep') emote('z z', 0, 'zz');
    else if (MOOD_EMOTE[mood] || emoteText) emote(emoteText || MOOD_EMOTE[mood], ms > 0 ? Math.min(ms, 2400) : 0);
    tint(MOOD_TINT[mood], ms > 0 ? ms : 0);
    if (!quiet && mood !== prev && MOOD_SOUND[mood]) playUi(MOOD_SOUND[mood]);
    if (ms > 0) moodTimer = setTimeout(() => setMood(''), ms);
  }
  function setMoodsEnabled(on) { softOrb.settings({ orbMoods: on }); moodsOn = !!on; if (!moodsOn) setMood(''); }

  // Toucher : « squish » au clic, tournis si on insiste (4 clics en 1,6 s).
  // Écouté au niveau du document avec un test de position : la zone de
  // préhension de la barre (#orb-grab) recouvre l'orbe et l'orb-wrap est en
  // pointer-events: none. On ne bloque rien : le glisser de fenêtre continue.
  const pokes = [];
  const inOrb = (e) => {
    const r = container.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    return r.width > 0 && Math.hypot(dx, dy) <= r.width * 0.46;
  };
  document.addEventListener('pointerdown', (e) => {
    if (!moodsOn || !orbEnabled || avatarMode !== 'orb' || !inOrb(e)) return;
    noteActivity();
    container.classList.add('orb-squish');
    playUi('squish');
    setTimeout(() => container.classList.remove('orb-squish'), 110);
    const now = performance.now();
    pokes.push(now);
    while (pokes.length && now - pokes[0] > 1600) pokes.shift();
    if (pokes.length >= 4) { pokes.length = 0; setMood('dizzy', { ms: 2600 }); }
    else if (mood !== 'dizzy') setMood('surprised', { ms: 650, quiet: true });
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!moodsOn) return;
    container.classList.toggle('orb-hover', inOrb(e));
  }, { passive: true });

  // Sommeil : après 10 min sans activité (pointeur, clavier, état ≠ idle),
  // l'orbe s'endort ; le moindre geste la réveille.
  const SLEEP_MS = 10 * 60 * 1000;
  let lastActivity = Date.now();
  function noteActivity() {
    lastActivity = Date.now();
    if (mood === 'sleep') { setMood(''); playUi('wake'); emote('!', 700); }
  }
  ['pointermove', 'keydown', 'wheel'].forEach((ev) => window.addEventListener(ev, noteActivity, { passive: true }));
  setInterval(() => {
    container.dataset.night = (() => { const h = new Date().getHours(); return h >= 22 || h < 6 ? '1' : '0'; })();
    if (moodsOn && !mood && state === 'idle' && !actionExecuting && Date.now() - lastActivity > SLEEP_MS) setMood('sleep', { ms: 0 });
  }, 15000);

  window.addEventListener('storage', (e) => {
    if (e.key === 'orbMoods') setMoodsEnabled(e.newValue !== 'false');
  });

  window.LumenOrb = {
    setCharacter, setMood, setMoodsEnabled, emote,
    setState, setColors, setActionExecuting, setSize, setCoreScale, setGlassType, setPulse, setEnabled,
    setHeartbeat, setHeartColor, setPulseStrength, setPulseSpeed, pulseHeart, setInnerIcons,
    setRobotHeadOptions: value => robotHead.settings(value),
    applyAppearance, setAvatarMode, setCustomAmbientLight, reloadCustomAvatar: loadCustomAvatar,
    accentPalette, ACCENT_THEME,
    setMouth, playVoiceEnvelope,
    get DEFAULT_COLORS() { return DEFAULT_COLORS_FN(); },
    GLASS_TYPES,
  };

  // ---- Double-clic sur l'avatar : « tais-toi » ----------------------------
  //
  // Il n'existait aucun geste pour interrompre une énonciation : il fallait
  // attendre la fin, ou rouvrir le menu d'où elle était partie. L'avatar est
  // ce qu'on regarde quand Lumen parle — c'est donc là qu'on le coupe.
  // Posé sur le CONTENEUR, présent aussi bien dans la barre que dans le
  // bureau ; la zone de préhension (#orb-grab) le recouvre dans la barre, on
  // écoute donc en phase de capture pour l'attraper avant elle.
  //
  // Un simple clic est déjà pris (déplacer la fenêtre) : d'où le double.
  container.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopAllSpeech();
    setState('idle');
  }, true);

  // ---- Eyes follow the cursor (centered while speaking) ----
  const eyeTarget = { x: 0, y: 0 };
  const eyeNow = { x: 0, y: 0 };
  window.addEventListener('mousemove', (e) => {
    const r = container.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    eyeTarget.x = Math.max(-1, Math.min(1, (e.clientX - cx) / 130)) * 6.5;
    eyeTarget.y = Math.max(-1, Math.min(1, (e.clientY - cy) / 130)) * 4.8;
  });
  window.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) { eyeTarget.x = 0; eyeTarget.y = 0; }
  });

  // ---- Animation ----
  const clock = new THREE.Clock();
  let raf = null;
  let colorTime = 0;
  let audioLevel = 0;

  let lastFrame = 0;
  function animate(now = 0) {
    raf = requestAnimationFrame(animate);
    // Cadence plafonnée si la page hôte le demande (window.__lumenOrbFps).
    const fps = window.__lumenOrbFps;
    if (fps && now - lastFrame < 1000 / fps - 2) return;
    lastFrame = now;
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    if (selectedCharacter !== 'default') return;
    customMixer?.update(dt);

    coreUniforms.uSpeed.value += (targets.speed - coreUniforms.uSpeed.value) * 0.05;
    coreUniforms.uIntensity.value += (targets.intensity - coreUniforms.uIntensity.value) * 0.06;

    let audioTarget;
    if (state === 'speaking') audioTarget = 0.40 + 0.60 * syntheticLevel(t);
    else if (state === 'thinking') audioTarget = 0.40 + 0.12 * (0.5 + 0.5 * Math.sin(t * 2.0));
    else audioTarget = 0.05 + 0.05 * (0.5 + 0.5 * Math.sin(t * 0.8));
    const k = state === 'speaking' ? 0.35 : 0.06;
    audioLevel += (audioTarget - audioLevel) * k;
    coreUniforms.uAudio.value = audioLevel;
    try { window.OrbBridge && window.OrbBridge.pushLevel(audioLevel, state); } catch (e) {}

    colorTime += dt * coreUniforms.uSpeed.value * 3.0;
    coreUniforms.uTime.value = colorTime;

    // Heartbeat ripple: expand the ring outward while fading it out.
    if (pulseActive) {
      const pe = (clock.elapsedTime - pulseStart) / pulseDuration();
      if (pe >= 1.0) {
        pulseActive = false;
        coreUniforms.uPulse.value = 0.0;
        coreUniforms.uPulseRadius.value = 0.0;
      } else {
        coreUniforms.uPulseRadius.value = pe * 1.1;
        coreUniforms.uPulse.value = (1.0 - pe) * orbPulseStrength;
      }
    }

    core.rotation.y += dt * 0.25;
    core.rotation.x = Math.sin(t * 0.3) * 0.12;
    shell.rotation.copy(core.rotation);

    // Spin the themed inner icons (if any) on their own slow orbit.
    if (iconGroup.children.length) {
      iconGroup.rotation.y += dt * 0.6;
      iconGroup.rotation.x = Math.sin(t * 0.4) * 0.18;
    }

    const scale = 1.0 + (state === 'speaking' ? audioLevel * 0.05 * orbPulse : Math.sin(t * 1.0) * 0.012);
    core.scale.setScalar(scale * coreBaseScale);
    shell.scale.setScalar(scale);
    // Le flottement appartient à l'orbe. Un avatar GLB conserve exactement
    // la position issue de son animation Blender, sans rebond ajouté par Lumen.
    container.style.setProperty('--orb-bob', avatarMode === 'custom' ? '0px' : `${Math.sin(t * 1.1) * 4}px`);

    // eyes: track cursor, but stay centered while speaking
    const speaking = state === 'speaking';
    const tx = speaking ? 0 : eyeTarget.x;
    const ty = speaking ? 0 : eyeTarget.y;
    eyeNow.x += (tx - eyeNow.x) * 0.12;
    eyeNow.y += (ty - eyeNow.y) * 0.12;
    if (eyesEl) eyesEl.style.transform = `translate(${eyeNow.x}px, ${eyeNow.y - 4}px)`;

    // Bouche : s'ouvre en hauteur avec le niveau de voix et se resserre
    // légèrement en largeur, comme une vraie bouche qui s'arrondit. Au repos
    // elle reste une fine barre fermée, dans l'axe du regard.
    if (mouthEl && orbMouth) {
      mouthLevel += (mouthLevelNow(t) - mouthLevel) * 0.16; // lissé : bouche moins nerveuse
      const s = mouthScale(mouthLevel);
      mouthEl.style.transform = `translate(${eyeNow.x}px, ${eyeNow.y}px)`;
      if (mouthBase) {
        const w = mouthBase.width * s.x, h = mouthBase.height * s.y;
        mouthEl.style.width = `${w.toFixed(1)}px`;
        mouthEl.style.height = `${h.toFixed(1)}px`;
        mouthEl.style.marginLeft = `${(-w / 2).toFixed(1)}px`;
        mouthEl.style.top = `${(mouthBase.centerY - h / 2).toFixed(1)}px`;
      }
      // Invisible tant que Lumen ne parle pas : la bouche naît de la voix.
      mouthEl.style.opacity = mouthOpacity(mouthLevel).toFixed(3);
    }

    renderer.render(scene, camera);
  }

  function start() { if (avatarMode === 'robot-head' || selectedCharacter !== 'default') return; if (!raf) { clock.start(); animate(); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else if (orbEnabled) start();
  });

  if (orbEnabled) start(); else setEnabled(false);
})();
