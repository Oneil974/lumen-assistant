// Spectromètre de dictée Whisper — retour visuel pendant l'écoute locale.
//
// Un canvas de barres inséré dans la capsule de saisie, qui raconte les trois
// temps de la dictée :
//   1. début   → les barres surgissent une à une (le micro est ouvert) ;
//   2. écoute  → spectre en direct (AnalyserNode), barres teintées « voix »
//                quand le seuil de parole est franchi, atténuées sinon ; dès
//                que la pause après la parole commence, un fin trait sous les
//                barres se vide de gauche à droite : quand il a disparu,
//                l'enregistrement s'arrête (c'est le compte à rebours des 2 s
//                de silence de whisper-dictation.js) ;
//   3. fin     → les barres s'affaissent d'un coup en une ligne, puis un
//                balayage lumineux signale « transcription » jusqu'à hide().
//
//   const viz = createDictationVisualizer(hostEl, { before: attachBtn });
//   viz.start();                        // phase 1
//   viz.setAnalyser(analyser);          // phase 2 (via onAnalyser)
//   viz.setLevel(lvl, speaking, ending) // via onLevel
//   viz.end();                          // phase 3 (état "transcribing")
//   viz.hide();                         // retire le canvas
//
// Les couleurs viennent des jetons de la page (--text-muted / --accent) pour
// suivre le thème ; la couleur « voix » reste le rouge du micro (#ef4444).

const BARS = 26;
const VOICE = "#ef4444";

function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export function createDictationVisualizer(host, { before = null, width = 132, height = 24 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "dictation-viz";
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);

  let analyser = null;
  let bins = null;
  let phase = "idle";        // idle | intro | live | outro | transcribing
  let phaseT0 = 0;
  let raf = 0;
  let speaking = false, level = 0, ending = 0;
  // Hauteurs lissées (0..1) : la source change (intro synthétique → spectre
  // réel → affaissement) mais les barres, elles, glissent sans à-coup.
  const heights = new Float32Array(BARS);
  const targets = new Float32Array(BARS);

  function mount() {
    if (canvas.isConnected) return;
    if (before && before.parentNode === host) host.insertBefore(canvas, before);
    else host.appendChild(canvas);
    requestAnimationFrame(() => canvas.classList.add("visible"));
  }

  function setPhase(p) { phase = p; phaseT0 = performance.now(); }

  function computeTargets(now) {
    const dt = now - phaseT0;
    if (phase === "intro") {
      // Vague de gauche à droite sur ~420 ms, chaque barre monte puis se pose
      // à un « souffle » minimal — signal que le micro est ouvert.
      for (let i = 0; i < BARS; i++) {
        const local = Math.max(0, Math.min(1, (dt - i * 12) / 220));
        targets[i] = Math.sin(local * Math.PI) * 0.7 + local * 0.12;
      }
      if (dt > 420 + BARS * 12 && analyser) setPhase("live");
      return;
    }
    if (phase === "live") {
      if (analyser) {
        if (!bins) bins = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(bins);
        // Les basses (voix) sont concentrées dans les premières bandes : on
        // répartit BARS barres sur les 2/3 utiles avec une légère courbe
        // logarithmique, en miroir depuis le centre (lecture symétrique).
        const usable = Math.floor(bins.length * 0.66);
        const half = Math.ceil(BARS / 2);
        for (let i = 0; i < half; i++) {
          const f = Math.pow(i / half, 1.4) * usable;
          const a = bins[Math.floor(f)] || 0, b = bins[Math.min(usable - 1, Math.floor(f) + 1)] || 0;
          const v = Math.max(a, b) / 255;
          const h = 0.1 + v * (speaking ? 0.9 : 0.55);
          targets[half - 1 - i] = h;
          targets[Math.min(BARS - 1, half + i)] = h;
        }
      } else {
        for (let i = 0; i < BARS; i++) targets[i] = 0.12 + level * 0.6 * Math.random();
      }
      return;
    }
    if (phase === "outro") {
      // Affaissement en 260 ms vers une ligne plate.
      const k = 1 - Math.min(1, dt / 260);
      for (let i = 0; i < BARS; i++) targets[i] = heights[i] * k;
      if (dt > 260) setPhase("transcribing");
      return;
    }
    for (let i = 0; i < BARS; i++) targets[i] = 0;
  }

  function draw(now) {
    computeTargets(now);
    const ease = phase === "outro" ? 0.5 : 0.35;
    for (let i = 0; i < BARS; i++) heights[i] += (targets[i] - heights[i]) * ease;

    ctx.clearRect(0, 0, width, height);
    const muted = cssVar(canvas, "--text-muted", "#8a8a8e");
    const accent = cssVar(canvas, "--accent-color", cssVar(canvas, "--accent", "#3b82f6"));
    const gap = 2, bw = (width - gap * (BARS - 1)) / BARS;
    const mid = height / 2;
    const maxH = height - 6; // 3 px de marge pour le trait de fin

    if (phase === "transcribing") {
      // Ligne plate + balayage lumineux : « on réfléchit ».
      const dt = (now - phaseT0) % 1100;
      const x = -30 + (width + 60) * (dt / 1100);
      ctx.fillStyle = muted; ctx.globalAlpha = 0.35;
      ctx.fillRect(0, mid - 1, width, 2);
      const g = ctx.createLinearGradient(x - 30, 0, x + 30, 0);
      g.addColorStop(0, "transparent"); g.addColorStop(0.5, accent); g.addColorStop(1, "transparent");
      ctx.globalAlpha = 1; ctx.fillStyle = g;
      ctx.fillRect(x - 30, mid - 1, 60, 2);
    } else {
      const color = phase === "live" ? (speaking ? VOICE : muted) : accent;
      ctx.fillStyle = color;
      ctx.globalAlpha = phase === "live" && !speaking ? 0.7 : 1;
      for (let i = 0; i < BARS; i++) {
        const h = Math.max(2, heights[i] * maxH);
        const x = i * (bw + gap);
        ctx.beginPath();
        ctx.roundRect(x, mid - h / 2, bw, h, bw / 2);
        ctx.fill();
      }
      // Compte à rebours de fin : un trait qui se vide, sous les barres.
      if (phase === "live" && ending > 0) {
        ctx.globalAlpha = 0.9; ctx.fillStyle = VOICE;
        ctx.fillRect(0, height - 2, width * (1 - ending), 2);
      }
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(draw);
  }

  function loop() { if (!raf) raf = requestAnimationFrame(draw); }

  return {
    el: canvas,
    start() {
      mount(); heights.fill(0); targets.fill(0); analyser = null; bins = null;
      speaking = false; level = 0; ending = 0;
      setPhase("intro"); loop();
    },
    setAnalyser(a) { analyser = a; bins = null; },
    setLevel(lvl, spk, end) { level = lvl || 0; speaking = !!spk; ending = end || 0; },
    end() { if (phase === "live" || phase === "intro") setPhase("outro"); ending = 0; },
    hide() {
      cancelAnimationFrame(raf); raf = 0; setPhase("idle"); analyser = null;
      canvas.classList.remove("visible");
      setTimeout(() => { if (phase === "idle") canvas.remove(); }, 220);
    },
  };
}
