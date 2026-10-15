// Rendu d'une image du montage dans un canvas 2D : fond, piste principale (avec
// transitions), incrustations, textes. Le même code sert l'aperçu et l'export
// (le canvas est enregistré tel quel), donc ce qu'on voit est ce qu'on exporte.
//
// Filtres : `ctx.filter` (CSS) quand le moteur le connaît ; sinon des
// approximations par modes de fusion (saturation, overlay, soft-light) et un
// flou par réduction/agrandissement — moins fidèles, mais jamais absents.

import { clipLen, mainAt, total, transDur } from "./editor-model.js";
import { fontCss } from "./editor-catalog.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const backOut = (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
const bounceOut = (x) => {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
};

export const FILTER_OK = (() => {
  try {
    const c = document.createElement("canvas").getContext("2d");
    if (!("filter" in c)) return false;
    c.filter = "blur(2px)";
    return c.filter === "blur(2px)";
  } catch { return false; }
})();

export function createRenderer(canvas, { getP, mediaOf }) {
  const g = canvas.getContext("2d");
  const scratch = document.createElement("canvas");
  const sg = scratch.getContext("2d");
  let W = canvas.width, H = canvas.height, U = 1;

  const sizeOf = (el) => [el?.videoWidth || el?.naturalWidth || 0, el?.videoHeight || el?.naturalHeight || 0];

  function cssFilter(f, blurPx) {
    const parts = [];
    if (f.brightness) parts.push(`brightness(${(1 + f.brightness).toFixed(3)})`);
    if (f.contrast) parts.push(`contrast(${(1 + f.contrast).toFixed(3)})`);
    if (f.saturation) parts.push(`saturate(${Math.max(0, 1 + f.saturation).toFixed(3)})`);
    if (f.hue) parts.push(`hue-rotate(${Math.round(f.hue * 180)}deg)`);
    if (blurPx > 0.3) parts.push(`blur(${blurPx.toFixed(1)}px)`);
    return parts.join(" ") || "none";
  }

  /** Dessine `src` (média, ou couleur si `color`) dans le rect, filtré. */
  function drawFiltered(src, color, x, y, w, h, f, extraBlur = 0) {
    const A = g.globalAlpha;
    const blurPx = (f?.blur || 0) * 40 * U + extraBlur;
    const paint = () => {
      if (color) { g.fillStyle = color; g.fillRect(x, y, w, h); }
      else g.drawImage(src, x, y, w, h);
    };
    if (!f) { paint(); return; }
    if (FILTER_OK) {
      g.filter = cssFilter(f, blurPx);
      paint();
      g.filter = "none";
    } else {
      if (blurPx > 0.6 && !color) {
        const k = 1 + blurPx / 2.5;
        scratch.width = Math.max(2, Math.round(w / k)); scratch.height = Math.max(2, Math.round(h / k));
        sg.imageSmoothingEnabled = true;
        sg.drawImage(src, 0, 0, scratch.width, scratch.height);
        g.imageSmoothingEnabled = true;
        g.drawImage(scratch, x, y, w, h);
      } else paint();
      if (f.saturation < 0) {
        g.globalCompositeOperation = "saturation";
        g.globalAlpha = A * Math.min(1, -f.saturation);
        g.fillStyle = "#808080"; g.fillRect(x, y, w, h);
      }
      if (f.contrast > 0 && !color) {
        g.globalCompositeOperation = "overlay";
        g.globalAlpha = A * Math.min(1, f.contrast);
        g.drawImage(src, x, y, w, h);
      } else if (f.contrast < 0) {
        g.globalCompositeOperation = "source-over";
        g.globalAlpha = A * Math.min(0.6, -f.contrast * 0.5);
        g.fillStyle = "#808080"; g.fillRect(x, y, w, h);
      }
      if (f.brightness > 0) {
        g.globalCompositeOperation = "screen";
        g.globalAlpha = A * Math.min(1, f.brightness * 0.7);
        g.fillStyle = "#ffffff"; g.fillRect(x, y, w, h);
      } else if (f.brightness < 0) {
        g.globalCompositeOperation = "source-over";
        g.globalAlpha = A * Math.min(0.9, -f.brightness * 0.75);
        g.fillStyle = "#000000"; g.fillRect(x, y, w, h);
      }
    }
    if (f.temperature) {
      g.globalCompositeOperation = "soft-light";
      g.globalAlpha = A * Math.min(1, Math.abs(f.temperature) * 0.6);
      g.fillStyle = f.temperature > 0 ? "#ff8a2a" : "#2a7dff";
      g.fillRect(x, y, w, h);
    }
    if (f.vignette > 0) {
      g.globalCompositeOperation = "source-over";
      g.globalAlpha = A;
      const cx = x + w / 2, cy = y + h / 2, r = Math.hypot(w, h) / 2;
      const grad = g.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(1, `rgba(0,0,0,${Math.min(0.95, f.vignette * 0.9)})`);
      g.fillStyle = grad; g.fillRect(x, y, w, h);
    }
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = A;
  }

  function motionOf(item, p) {
    switch (item.motion) {
      case "in": return { s: 1 + 0.14 * p, x: 0, y: 0 };
      case "out": return { s: 1.14 - 0.14 * p, x: 0, y: 0 };
      case "left": return { s: 1.12, x: 0.045 - 0.09 * p, y: 0 };
      case "right": return { s: 1.12, x: -0.045 + 0.09 * p, y: 0 };
      case "up": return { s: 1.12, x: 0, y: 0.045 - 0.09 * p };
      default: return { s: 1, x: 0, y: 0 };
    }
  }

  /**
   * Un visuel (clip principal ou incrustation). `fx` : effets de transition
   * { alpha, dx, dy, scale, rot, blur, mask(g) }. Renvoie sa boîte à l'écran.
   */
  function drawVisual(item, local, len, isMain, fx = {}) {
    const el = item.kind === "color" ? null : mediaOf(item);
    let [w, h] = item.kind === "color" ? [W, H] : sizeOf(el);
    if (!w || !h) return null;
    const tf = item.transform;
    const base = item.kind === "color" ? 1 : (isMain && item.fit !== "contain" ? Math.max : Math.min)(W / w, H / h);
    const m = motionOf(item, len > 0 ? clamp(local / len, 0, 1) : 0);
    const s = base * (tf.scale || 1) * m.s * (fx.scale || 1);
    const cx = W / 2 + (tf.x + m.x) * W + (fx.dx || 0);
    const cy = H / 2 + (tf.y + m.y) * H + (fx.dy || 0);
    const fade = Math.min(item.fadeIn ? local / item.fadeIn : 1, item.fadeOut ? (len - local) / item.fadeOut : 1);
    const dw = w * s, dh = h * s;
    g.save();
    fx.mask?.(g);
    g.translate(cx, cy);
    g.rotate((((tf.rotate || 0) + (fx.rot || 0)) * Math.PI) / 180);
    g.scale(tf.flipH ? -1 : 1, tf.flipV ? -1 : 1);
    g.globalAlpha = clamp((tf.opacity ?? 1) * (fx.alpha ?? 1) * (isMain ? 1 : clamp(fade, 0, 1)), 0, 1);
    drawFiltered(el, item.kind === "color" ? item.color || "#000" : null, -dw / 2, -dh / 2, dw, dh, item.filter, fx.blur || 0);
    g.restore();
    return { x: cx - dw / 2, y: cy - dh / 2, w: dw, h: dh, fade: isMain ? clamp(fade, 0, 1) : 1 };
  }

  function background(P, hits) {
    const bg = P.bg || {};
    g.fillStyle = bg.mode === "color" ? bg.color || "#000" : "#000";
    g.fillRect(0, 0, W, H);
    if (bg.mode !== "blur" || !hits.length) return;
    const item = hits[0].clip;
    if (item.kind === "color") return;
    const el = mediaOf(item);
    const [w, h] = sizeOf(el);
    if (!w || !h) return;
    // Flou de fond : réduction à ~40 px puis agrandissement lissé — rapide et
    // identique sur tous les moteurs.
    scratch.width = 48; scratch.height = Math.max(2, Math.round((48 * H) / W));
    const s = Math.max(scratch.width / w, scratch.height / h);
    sg.drawImage(el, (scratch.width - w * s) / 2, (scratch.height - h * s) / 2, w * s, h * s);
    g.imageSmoothingEnabled = true;
    g.drawImage(scratch, 0, 0, W, H);
    g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(0, 0, W, H);
  }

  function flash(color, a) {
    if (a <= 0) return;
    g.save(); g.globalAlpha = clamp(a, 0, 1); g.fillStyle = color; g.fillRect(0, 0, W, H); g.restore();
  }

  function drawMain(P, t, hits, boxes) {
    if (!hits.length) return;
    if (hits.length === 1) {
      const h = hits[0];
      const b = drawVisual(h.clip, t - h.start, h.len, true);
      if (b) { boxes.push({ id: h.clip.id, type: "clip", ...b }); flash("#000", 1 - b.fade); }
      return;
    }
    // Transition : A = clip sortant (porte la transition), B = entrant.
    const [A, B] = hits;
    const d = transDur(P, A.i) || 0.01;
    const p = ease(clamp((t - B.start) / d, 0, 1));
    const type = A.clip.transition?.type || "fade";
    const la = t - A.start, lb = t - B.start;
    let ba = null, bb = null;
    switch (type) {
      case "black":
      case "white": {
        const col = type === "black" ? "#000" : "#fff";
        if (p < 0.5) { ba = drawVisual(A.clip, la, A.len, true); flash(col, p * 2); }
        else { bb = drawVisual(B.clip, lb, B.len, true); flash(col, (1 - p) * 2); }
        break;
      }
      case "slideleft": ba = drawVisual(A.clip, la, A.len, true, { dx: -p * W }); bb = drawVisual(B.clip, lb, B.len, true, { dx: (1 - p) * W }); break;
      case "slideright": ba = drawVisual(A.clip, la, A.len, true, { dx: p * W }); bb = drawVisual(B.clip, lb, B.len, true, { dx: -(1 - p) * W }); break;
      case "slideup": ba = drawVisual(A.clip, la, A.len, true, { dy: -p * H }); bb = drawVisual(B.clip, lb, B.len, true, { dy: (1 - p) * H }); break;
      case "zoom": ba = drawVisual(A.clip, la, A.len, true, { scale: 1 + p * 0.8, alpha: 1 - p }); bb = drawVisual(B.clip, lb, B.len, true, { scale: 1.25 - 0.25 * p, alpha: p }); break;
      case "wipe": ba = drawVisual(A.clip, la, A.len, true); bb = drawVisual(B.clip, lb, B.len, true, { mask: (c) => { c.beginPath(); c.rect(0, 0, W * p, H); c.clip(); } }); break;
      case "circle": ba = drawVisual(A.clip, la, A.len, true); bb = drawVisual(B.clip, lb, B.len, true, { mask: (c) => { c.beginPath(); c.arc(W / 2, H / 2, (Math.hypot(W, H) / 2) * p + 0.5, 0, Math.PI * 2); c.clip(); } }); break;
      case "blur": ba = drawVisual(A.clip, la, A.len, true, { blur: p * 24 * U }); bb = drawVisual(B.clip, lb, B.len, true, { blur: (1 - p) * 24 * U, alpha: p }); break;
      case "spin": ba = drawVisual(A.clip, la, A.len, true, { rot: p * 120, scale: 1 - p * 0.4, alpha: 1 - p }); bb = drawVisual(B.clip, lb, B.len, true, { rot: -(1 - p) * 120, scale: 0.6 + 0.4 * p, alpha: p }); break;
      default: ba = drawVisual(A.clip, la, A.len, true); bb = drawVisual(B.clip, lb, B.len, true, { alpha: p });
    }
    if (ba) boxes.push({ id: A.clip.id, type: "clip", ...ba });
    if (bb) boxes.push({ id: B.clip.id, type: "clip", ...bb });
  }

  // ---- Texte ----------------------------------------------------------------
  function wrap(text, maxW) {
    const lines = [];
    for (const para of String(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        if (!word) continue;
        const test = line ? `${line} ${word}` : word;
        if (g.measureText(test).width > maxW && line) { lines.push(line); line = word; } else line = test;
      }
      lines.push(line);
    }
    return lines;
  }

  function animState(x, t, editing) {
    const st = { alpha: 1, dx: 0, dy: 0, scale: 1, blur: 0, chars: Infinity };
    if (editing) return st;
    const local = t - x.start, len = x.end - x.start;
    const dur = Math.max(0.05, Math.min(x.anim?.dur || 0.3, len / 2));
    const pin = clamp(local / dur, 0, 1), pout = clamp((len - local) / dur, 0, 1);
    const ein = ease(pin), eout = ease(pout);
    switch (x.anim?.in) {
      case "fade": st.alpha *= ein; break;
      case "pop": st.scale *= pin < 1 ? 0.4 + 0.6 * backOut(pin) : 1; st.alpha *= Math.min(1, pin * 3); break;
      case "slideup": st.dy += (1 - ein) * 0.08 * H; st.alpha *= ein; break;
      case "slidedown": st.dy -= (1 - ein) * 0.08 * H; st.alpha *= ein; break;
      case "slideleft": st.dx -= (1 - ein) * 0.12 * W; st.alpha *= ein; break;
      case "zoom": st.scale *= 1.7 - 0.7 * ein; st.alpha *= ein; break;
      case "bounce": st.dy -= (1 - bounceOut(pin)) * 0.18 * H; st.alpha *= Math.min(1, pin * 4); break;
      case "blur": st.blur = (1 - ein) * 18 * U; st.alpha *= ein; break;
      case "typewriter": {
        // Machine à écrire : la frappe dure toute la durée d'animation.
        const n = [...String(x.text)].length;
        st.chars = Math.floor(n * clamp(local / Math.max(0.2, x.anim.dur || 1), 0, 1));
        break;
      }
      default: break;
    }
    switch (x.anim?.out) {
      case "fade": st.alpha *= eout; break;
      case "pop": st.scale *= pout < 1 ? 0.4 + 0.6 * backOut(pout) : 1; st.alpha *= Math.min(1, pout * 3); break;
      case "slideup": st.dy -= (1 - eout) * 0.08 * H; st.alpha *= eout; break;
      case "slidedown": st.dy += (1 - eout) * 0.08 * H; st.alpha *= eout; break;
      case "zoom": st.scale *= 1 + 0.6 * (1 - eout); st.alpha *= eout; break;
      default: break;
    }
    return st;
  }

  function drawText(x, t, editing) {
    const st = animState(x, t, editing);
    if (st.alpha <= 0.001) return null;
    const size = (x.size || 64) * U;
    g.save();
    g.font = `${x.weight || 700} ${size}px ${fontCss(x.font)}`;
    const raw = x.upper ? String(x.text).toUpperCase() : String(x.text);
    const lines = wrap(raw, (x.maxW || 0.86) * W);
    const lh = size * 1.18;
    const widths = lines.map((l) => g.measureText(l).width);
    const bw = Math.max(1, ...widths), bh = lines.length * lh;
    const align = x.align || "center";
    const ax = (x.x ?? 0.5) * W + st.dx, ay = (x.y ?? 0.5) * H + st.dy;
    const left = align === "left" ? ax : align === "right" ? ax - bw : ax - bw / 2;
    const top = ay - bh / 2;
    g.translate(left + bw / 2, ay);
    g.rotate(((x.rotate || 0) * Math.PI) / 180);
    g.scale(st.scale, st.scale);
    g.translate(-(left + bw / 2), -ay);
    g.globalAlpha = clamp(st.alpha, 0, 1);
    if (FILTER_OK && st.blur > 0.3) g.filter = `blur(${st.blur.toFixed(1)}px)`;
    const pad = size * 0.32;
    if (x.bg && x.bg !== "transparent" && x.kind !== "sticker") {
      g.fillStyle = x.bg;
      g.beginPath();
      const r = [left - pad, top - pad * 0.55, bw + pad * 2, bh + pad * 1.1];
      if (g.roundRect) g.roundRect(...r, size * 0.28); else g.rect(...r);
      g.fill();
    }
    g.textBaseline = "middle";
    g.textAlign = align;
    const xLine = align === "left" ? left : align === "right" ? left + bw : left + bw / 2;
    let budget = st.chars;
    lines.forEach((l, i) => {
      let s = l;
      if (budget !== Infinity) { const ch = [...l]; s = ch.slice(0, Math.max(0, budget)).join(""); budget -= ch.length + 1; }
      if (!s) return;
      const y = top + lh * i + lh / 2;
      if (x.glow) { g.shadowColor = x.glow; g.shadowBlur = size * 0.6; g.fillStyle = x.color; g.fillText(s, xLine, y); }
      else if (x.shadow) { g.shadowColor = "rgba(0,0,0,.65)"; g.shadowBlur = size * 0.16; g.shadowOffsetY = size * 0.04; }
      if (x.stroke > 0) {
        g.lineJoin = "round"; g.miterLimit = 2;
        g.lineWidth = x.stroke * U * 1.6; g.strokeStyle = x.strokeColor || "#000";
        g.strokeText(s, xLine, y);
        g.shadowBlur = 0; g.shadowOffsetY = 0;
      }
      g.fillStyle = x.color || "#fff";
      g.fillText(s, xLine, y);
      g.shadowBlur = 0; g.shadowOffsetY = 0;
    });
    g.restore();
    return { x: left - pad, y: top - pad * 0.55, w: bw + pad * 2, h: bh + pad * 1.1 };
  }

  /**
   * Dessine l'image du temps `t`. `editing` : à l'arrêt, les textes s'affichent
   * pleinement (sinon on ne pourrait pas régler un texte posé sur sa tête).
   * Renvoie les boîtes des éléments visibles, du dessous vers le dessus.
   */
  function render(t, { editing = false } = {}) {
    const P = getP();
    W = canvas.width; H = canvas.height; U = Math.min(W, H) / 1080;
    // Tête de lecture en fin de montage : on montre la dernière image, pas du noir.
    const T = total(P);
    if (T > 0 && t >= T) t = T - 0.001;
    const boxes = [];
    const hits = mainAt(P, t);
    background(P, hits);
    drawMain(P, t, hits, boxes);
    const ovs = P.overlays.filter((o) => t >= o.start && t < o.start + clipLen(o)).sort((a, b) => a.lane - b.lane);
    for (const o of ovs) {
      const b = drawVisual(o, t - o.start, clipLen(o), false);
      if (b) boxes.push({ id: o.id, type: "overlay", ...b });
    }
    const txs = P.texts.filter((x) => t >= x.start && t < x.end).sort((a, b) => a.lane - b.lane);
    for (const x of txs) {
      const b = drawText(x, t, editing);
      if (b) boxes.push({ id: x.id, type: "text", ...b });
    }
    return boxes;
  }

  return { render, get size() { return [W, H]; } };
}

