import { character, characterId } from './orb-characters.js';
const clamp = (value, fallback, min, max) => { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback; };
export function mountSoftOrb(host) {
  if (!document.querySelector('[data-soft-orb-style]')) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./soft-orb.css?v=6', import.meta.url).href; link.dataset.softOrbStyle = ''; document.head.append(link);
  }
  const node = document.createElement('div'); node.className = 'lumen-soft'; node.setAttribute('aria-hidden', 'true');
  node.innerHTML = '<div class="lumen-soft-pose"><div class="lumen-soft-body"><span class="lumen-soft-shine"></span><span class="lumen-soft-blush"></span><div class="lumen-soft-face"><i></i><i></i></div><span class="lumen-soft-mouth"></span></div></div><div class="lumen-soft-ring"></div><div class="lumen-soft-dots"><b></b><b></b><b></b></div><span class="lumen-soft-zz">z</span>';
  host.append(node);
  let active = false;
  let heartbeat = true;
  let moods = true;
  let finishTimer;
  let pulseTimer;
  let reactionTimer;
  let previousState = host.dataset.state || 'idle';
  let lastPointer = 0, glanceTimer = 0;
  const pointer = (event) => {
    lastPointer = performance.now();
    if (!active || document.hidden || host.dataset.state === 'speaking') return;
    const r = host.getBoundingClientRect();
    node.style.setProperty('--look-x', `${Math.max(-1, Math.min(1, (event.clientX - r.left - r.width / 2) / 180)) * 7}%`);
    node.style.setProperty('--look-y', `${Math.max(-1, Math.min(1, (event.clientY - r.top - r.height / 2) / 180)) * 5}%`);
  };
  const resetLook = () => { node.style.setProperty('--look-x', '0%'); node.style.setProperty('--look-y', '0%'); };
  window.addEventListener('pointermove', pointer, { passive: true });
  // Vie au repos : de petits coups d'œil spontanés quand personne ne bouge la
  // souris et que rien ne se passe (ni écoute, ni réflexion, ni parole).
  const glance = () => {
    glanceTimer = setTimeout(glance, 3500 + Math.random() * 5000);
    if (!active || document.hidden || !moods || performance.now() - lastPointer < 2500) return;
    if ((host.dataset.state || 'idle') !== 'idle' || host.dataset.mood) return;
    const x = (Math.random() * 2 - 1) * 8, y = (Math.random() * 2 - 1) * 5;
    node.style.setProperty('--look-x', `${x.toFixed(1)}%`); node.style.setProperty('--look-y', `${y.toFixed(1)}%`);
    setTimeout(() => { if (performance.now() - lastPointer >= 2500) resetLook(); }, 900 + Math.random() * 900);
  };
  glanceTimer = setTimeout(glance, 4000);
  window.addEventListener('blur', resetLook);
  const visibility = () => { node.classList.toggle('is-paused', document.hidden); if (document.hidden) resetLook(); };
  document.addEventListener('visibilitychange', visibility);
  const observer = new MutationObserver(() => {
    const state = host.dataset.state || 'idle';
    if (active && moods && previousState !== 'idle' && state === 'idle') {
      node.classList.add('is-finished'); clearTimeout(finishTimer); finishTimer = setTimeout(() => node.classList.remove('is-finished'), 900);
    }
    if (state === 'speaking') resetLook();
    previousState = state;
  });
  observer.observe(host, { attributes: true, attributeFilter: ['data-state'] });
  const poke = () => { if (!active || !moods) return; node.classList.add('is-poked'); clearTimeout(reactionTimer); reactionTimer = setTimeout(() => node.classList.remove('is-poked'), 750); };
  host.addEventListener('pointerdown', poke);
  visibility();
  return {
    apply(id, settings = {}) {
      const preset = character(id); active = preset.renderer !== 'original';
      host.dataset.orbCharacter = characterId(id); host.dataset.orbRenderer = active ? 'soft' : 'original';
      node.hidden = !active;
      for (const [key, value] of Object.entries({ '--soft-color': preset.color || '#fff', '--soft-shade': preset.shade || '#ddd', '--soft-eyes': preset.eyes || '#171719', '--soft-tempo': `${preset.tempo || 5}s`, '--soft-tilt': `${preset.tilt || 2}deg` })) node.style.setProperty(key, value);
      this.settings(settings);
    },
    settings(settings = {}) {
      if (settings.orbMoods != null) moods = String(settings.orbMoods) !== 'false';
      if (settings.orbHeartbeat != null) heartbeat = String(settings.orbHeartbeat) !== 'false';
      if (settings.orbPulse != null) node.style.setProperty('--soft-voice', clamp(settings.orbPulse, 100, 0, 250) / 100);
      if (settings.orbPulseStrength != null) node.style.setProperty('--soft-strength', clamp(settings.orbPulseStrength, 100, 0, 250) / 100);
      if (settings.orbPulseSpeed != null) node.style.setProperty('--soft-pulse-time', `${1.6 / (clamp(settings.orbPulseSpeed, 100, 10, 250) / 100)}s`);
    },
    pulse() { if (!active || !heartbeat || document.hidden) return; node.classList.remove('is-pulsing'); void node.offsetWidth; node.classList.add('is-pulsing'); clearTimeout(pulseTimer); pulseTimer = setTimeout(() => node.classList.remove('is-pulsing'), 16000); },
    dispose() { observer.disconnect(); window.removeEventListener('pointermove', pointer); window.removeEventListener('blur', resetLook); document.removeEventListener('visibilitychange', visibility); host.removeEventListener('pointerdown', poke); for (const timer of [finishTimer, pulseTimer, reactionTimer, glanceTimer]) clearTimeout(timer); node.remove(); },
  };
}
