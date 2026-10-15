// Lumen XR — mot d'éveil LOCAL (« Lumen »), sans réseau ni modèle.
//
// Principe : on enregistre trois fois « Lumen » prononcé par l'utilisateur ; on
// en garde l'empreinte acoustique (coefficients MFCC, une trame toutes les
// 10 ms). En mains libres, chaque prise de parole est comparée à ces modèles
// par alignement temporel (DTW) — le même mot dit plus vite ou plus lentement
// reste reconnu. Rien ne quitte le casque tant que le mot n'a pas été reconnu ;
// seule la phrase qui SUIT part ensuite à Whisper.
//
// C'est volontairement un détecteur « à gabarit », calibré sur UNE voix : léger
// (quelques millisecondes par prise de parole) et suffisant pour un casque
// personnel. Sans calibrage, xr.js garde le repli par Whisper.

const SR = 16000;
const FRAME = 400;   // 25 ms
const HOP = 160;     // 10 ms
const NFFT = 512;
const NMEL = 26;
const NCEP = 13;     // on garde c1..c12 (c0 = énergie, trop dépendante du volume)
const LS_KEY = "xrWakeTemplates";

// ---- MFCC ------------------------------------------------------------------
const hamming = Float32Array.from({ length: FRAME }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
const melFilters = (() => {
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const inv = (m) => 700 * (10 ** (m / 2595) - 1);
  const lo = mel(60), hi = mel(7600);
  const pts = Array.from({ length: NMEL + 2 }, (_, i) => inv(lo + ((hi - lo) * i) / (NMEL + 1)));
  const bins = pts.map((f) => Math.floor(((NFFT + 1) * f) / SR));
  return Array.from({ length: NMEL }, (_, m) => {
    const w = new Float32Array(NFFT / 2 + 1);
    for (let k = bins[m]; k < bins[m + 1]; k++) w[k] = (k - bins[m]) / Math.max(1, bins[m + 1] - bins[m]);
    for (let k = bins[m + 1]; k < bins[m + 2]; k++) w[k] = (bins[m + 2] - k) / Math.max(1, bins[m + 2] - bins[m + 1]);
    return w;
  });
})();
const dct = Array.from({ length: NCEP }, (_, i) => Float32Array.from({ length: NMEL }, (_, j) => Math.cos((Math.PI * i * (j + 0.5)) / NMEL)));

/// FFT radix-2 en place (réel → module au carré).
function powerSpectrum(frame) {
  const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
  re.set(frame);
  for (let i = 1, j = 0; i < NFFT; i++) {
    let bit = NFFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let len = 2; len <= NFFT; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < NFFT; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  const out = new Float32Array(NFFT / 2 + 1);
  for (let k = 0; k <= NFFT / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}

/// Trames MFCC (tableau de Float32Array de 12 valeurs), normalisées par
/// soustraction de la moyenne (robuste au micro et à la pièce).
export function mfcc(pcm) {
  const frames = [];
  const buf = new Float32Array(FRAME);
  for (let start = 0; start + FRAME <= pcm.length; start += HOP) {
    // Pré-accentuation + fenêtre de Hamming.
    for (let i = 0; i < FRAME; i++) buf[i] = (pcm[start + i] - 0.97 * (pcm[start + i - 1] || 0)) * hamming[i];
    const ps = powerSpectrum(buf);
    const logMel = new Float32Array(NMEL);
    for (let m = 0; m < NMEL; m++) {
      let e = 0;
      const w = melFilters[m];
      for (let k = 0; k < w.length; k++) e += w[k] * ps[k];
      logMel[m] = Math.log(e + 1e-10);
    }
    const c = new Float32Array(NCEP - 1);
    for (let i = 1; i < NCEP; i++) {
      let v = 0;
      for (let j = 0; j < NMEL; j++) v += dct[i][j] * logMel[j];
      c[i - 1] = v;
    }
    frames.push(c);
  }
  if (!frames.length) return frames;
  const mean = new Float32Array(NCEP - 1);
  for (const f of frames) for (let i = 0; i < mean.length; i++) mean[i] += f[i] / frames.length;
  for (const f of frames) for (let i = 0; i < mean.length; i++) f[i] -= mean[i];
  return frames;
}

/// Ne garde que la partie parlée (énergie au-dessus d'un seuil relatif).
export function trimSilence(pcm) {
  const win = 320;
  const energies = [];
  for (let i = 0; i + win <= pcm.length; i += win) {
    let s = 0;
    for (let j = 0; j < win; j++) s += pcm[i + j] * pcm[i + j];
    energies.push(Math.sqrt(s / win));
  }
  const peak = Math.max(...energies, 1e-6);
  const th = Math.max(0.012, peak * 0.12);
  const first = energies.findIndex((e) => e > th);
  let last = energies.length - 1;
  while (last > 0 && energies[last] <= th) last--;
  if (first < 0 || last <= first) return pcm;
  return pcm.subarray(Math.max(0, (first - 2) * win), Math.min(pcm.length, (last + 3) * win));
}

/// Distance DTW moyenne (par pas du chemin) entre deux suites de trames.
export function dtw(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return Infinity;
  const band = Math.max(8, Math.floor(Math.max(n, m) * 0.35)); // bande de Sakoe-Chiba
  let prev = new Float32Array(m + 1).fill(Infinity);
  let prevLen = new Uint16Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    const cur = new Float32Array(m + 1).fill(Infinity);
    const curLen = new Uint16Array(m + 1);
    const jc = Math.round((i * m) / n);
    for (let j = Math.max(1, jc - band); j <= Math.min(m, jc + band); j++) {
      let d = 0;
      const fa = a[i - 1], fb = b[j - 1];
      for (let k = 0; k < fa.length; k++) { const x = fa[k] - fb[k]; d += x * x; }
      d = Math.sqrt(d);
      let best = prev[j - 1], len = prevLen[j - 1];
      if (prev[j] < best) { best = prev[j]; len = prevLen[j]; }
      if (cur[j - 1] < best) { best = cur[j - 1]; len = curLen[j - 1]; }
      cur[j] = best + d;
      curLen[j] = len + 1;
    }
    prev = cur;
    prevLen = curLen;
  }
  return prev[m] / Math.max(1, prevLen[m]);
}

// ---- Modèles enregistrés ---------------------------------------------------
export class WakeWord {
  constructor() {
    this.templates = [];
    this.threshold = 0;
    this.load();
  }

  get ready() { return this.templates.length >= 2 && this.threshold > 0; }

  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      if (raw?.templates?.length) {
        this.templates = raw.templates.map((t) => t.map((f) => Float32Array.from(f)));
        this.threshold = raw.threshold;
      }
    } catch { this.templates = []; }
  }

  save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        templates: this.templates.map((t) => t.map((f) => Array.from(f, (v) => +v.toFixed(3)))),
        threshold: this.threshold,
      }));
    } catch {}
  }

  clear() {
    this.templates = [];
    this.threshold = 0;
    try { localStorage.removeItem(LS_KEY); } catch {}
  }

  /// Ajoute un exemple (PCM 16 kHz). Renvoie le nombre d'exemples retenus.
  addSample(pcm) {
    const feats = mfcc(trimSilence(pcm));
    if (feats.length < 15 || feats.length > 150) return this.templates.length; // 0,15 s – 1,5 s
    this.templates.push(feats);
    if (this.templates.length > 4) this.templates.shift();
    this.calibrate();
    this.save();
    return this.templates.length;
  }

  /// Seuil = écart maximal entre exemples, avec une marge : assez large pour
  /// reconnaître le mot dit autrement, assez serré pour ignorer le reste.
  calibrate() {
    const t = this.templates;
    if (t.length < 2) { this.threshold = 0; return; }
    let worst = 0;
    for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) worst = Math.max(worst, dtw(t[i], t[j]));
    this.threshold = worst * 1.3 + 2;
  }

  /// La prise de parole COMMENCE-t-elle par le mot d'éveil ? Renvoie
  /// { match, score, endSample } — endSample : où le mot finit (pour isoler
  /// ce qui suit).
  detect(pcm) {
    if (!this.ready) return { match: false, score: Infinity, endSample: 0 };
    const voiced = trimSilence(pcm);
    const lead = (voiced.byteOffset - pcm.byteOffset) / Float32Array.BYTES_PER_ELEMENT; // début de la parole
    const feats = mfcc(voiced.subarray(0, Math.min(voiced.length, SR * 1.6)));
    let best = Infinity, bestLen = 0;
    for (const tpl of this.templates) {
      // Le mot peut être suivi d'une phrase : on compare des débuts de
      // longueurs voisines de celle du modèle et on garde le meilleur.
      for (const k of [0.75, 0.9, 1, 1.15, 1.3]) {
        const len = Math.round(tpl.length * k);
        if (len > feats.length + 3) continue;
        const d = dtw(feats.slice(0, len), tpl);
        if (d < best) { best = d; bestLen = len; }
      }
    }
    return { match: best <= this.threshold, score: best, endSample: Math.max(0, lead) + bestLen * HOP + FRAME };
  }
}
