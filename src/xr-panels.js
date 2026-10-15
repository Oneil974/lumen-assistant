// Lumen XR — panneaux spatiaux.
//
// Un panneau = un plan Three.js texturé par un <canvas> 2D. On redessine le
// canvas quand son contenu change (pas à chaque image) : c'est léger pour le
// GPU du Quest et ça donne du texte net, du vrai rendu typographique, sans
// dépendre d'une bibliothèque d'UI 3D.
//
// L'interaction passe par des « zones » (rectangles en pixels du canvas) : le
// rayon d'une manette ou d'une main touche le plan, l'UV est converti en pixel,
// et la zone sous le pointeur reçoit le survol / le clic. Le bandeau du haut
// (la poignée) sert à déplacer le panneau.

import * as THREE from "/lib/three.module.js";
import { icon as lucide } from "/lib/icons.js";

// Tout le dessin se fait en coordonnées LOGIQUES (900 unités par mètre) ; la
// résolution réelle du canvas vaut logique × `density`. Le mode performance
// baisse la densité sans toucher à une seule mise en page.
export const PX_PER_M = 900;
let density = 1;
let maxAnisotropy = 4;
/// Appelé une fois le renderer créé (renderer.capabilities.getMaxAnisotropy()).
export function setMaxAnisotropy(n) { maxAnisotropy = Math.max(1, n || 1); }

const FONT = `-apple-system, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/// Découpe un texte en lignes qui tiennent dans `maxW` (mots trop longs coupés).
export function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of String(text || "").split(/\n/)) {
    if (!para.trim()) { out.push(""); continue; }
    let line = "";
    for (let word of para.split(/\s+/)) {
      while (ctx.measureText(word).width > maxW && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && ctx.measureText(word.slice(0, cut)).width > maxW) cut--;
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = word; }
      else line = test;
    }
    if (line) out.push(line);
  }
  return out;
}

/// Nettoyage Markdown minimal pour l'affichage en panneau (pas de rendu riche).
export function plain(md) {
  return String(md || "")
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ""))
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^*])\*(?!\s)([^*]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Canvas Markdown: structured blocks and inline styles, without HTML execution.
export function markdownLines(ctx, md, width, size = 27) {
  const lines = [];
  let code = false;
  for (let text of String(md || "").replace(/<think>[\s\S]*?<\/think>/g, "").split("\n")) {
    if (/^\s*```/.test(text)) { code = !code; continue; }
    const heading = !code && text.match(/^#{1,6}\s+/);
    const quote = !code && /^>\s?/.test(text);
    text = text.replace(/^#{1,6}\s+|^>\s?/g, "").replace(/^\s*[-*+]\s+/, "• ");
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    const parts = code ? [text] : text.split(/(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*)/g);
    let row = [], used = 0;
    const flush = () => { lines.push({ runs: row, width: used }); row = []; used = 0; };
    for (const part of parts) {
      const bold = heading || /^(\*\*|__)/.test(part), mono = code || /^`/.test(part), italic = quote || /^\*[^*]/.test(part);
      const value = code ? part : part.replace(/^(\*\*|__|`|\*)|(\*\*|__|`|\*)$/g, "");
      const font = `${italic ? "italic " : ""}${bold ? 700 : 400} ${size}px ${mono ? "monospace" : THEME.font}`;
      ctx.font = font;
      for (const word of value.split(/(\s+)/).filter(Boolean)) {
        for (const chunk of (/^\s+$/.test(word) ? [word] : wrap(ctx, word, width))) {
          const w = ctx.measureText(chunk).width;
          if (used + w > width && row.length) flush();
          row.push({ text: chunk, font, code: mono, quote }); used += w;
        }
      }
    }
    flush();
  }
  return lines;
}
export function drawMarkdownLine(ctx, line, x, y, color = THEME.text) {
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  for (const run of line.runs) {
    ctx.font = run.font; ctx.fillStyle = run.code ? "#d1b8ff" : run.quote ? THEME.dim : color;
    ctx.fillText(run.text, x, y); x += ctx.measureText(run.text).width;
  }
}

// ---- Icônes Lucide (le jeu de Lumen, lib/icons.js) ------------------------
// Un SVG ne se dessine pas directement sur un canvas : on le charge une fois
// comme image (par nom + couleur + graisse), puis on repeint les panneaux qui
// l'attendaient. D'ici là, rien n'est dessiné — l'icône apparaît à l'image suivante.
const ICON_CACHE = new Map();
const LIVE_PANELS = new Set();

function iconImage(name, color, stroke) {
  const key = `${name}|${color}|${stroke}`;
  let img = ICON_CACHE.get(key);
  if (img) return img.complete && img.naturalWidth ? img : null;
  const svg = lucide(name, { stroke })
    .replace("<svg ", `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" color="${color}" `);
  if (!svg) return null;
  img = new Image();
  img.onload = () => LIVE_PANELS.forEach((p) => p.invalidate());
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  ICON_CACHE.set(key, img);
  return null;
}

/// Dessine une icône Lucide centrée dans le carré (x, y, size).
export function drawIcon(ctx, name, x, y, size, color = "#ffffff", stroke = 2) {
  const img = iconImage(name, color, stroke);
  if (img) ctx.drawImage(img, x, y, size, size);
}

export const THEME = {
  // Verre très léger : la pièce (passthrough) reste visible à travers.
  glass: "rgba(22, 24, 32, 0.42)",
  glassTop: "rgba(70, 74, 92, 0.38)",
  stroke: "rgba(255,255,255,0.22)",
  text: "#f4f5f8",
  dim: "rgba(235,238,245,0.62)",
  userBubble: "#3b82f6",
  botBubble: "rgba(255,255,255,0.16)",
  hover: "rgba(255,255,255,0.16)",
  accent: "#9961ff",
  danger: "#ff5470",
  font: FONT,
};

/// Change la résolution de TOUS les panneaux (mode performance).
export function setPanelDensity(d) {
  if (d === density) return;
  density = d;
  LIVE_PANELS.forEach((p) => p.applyDensity());
}

export class Panel {
  /**
   * @param {object} o
   * @param {number} o.width  largeur en mètres
   * @param {number} o.height hauteur en mètres
   * @param {string} [o.title]
   * @param {(ctx, panel) => void} o.draw  dessine le contenu (sous la poignée)
   */
  constructor({ width, height, title = "", draw, handle = true, radius = 46, closable = false, onClose = null, bare = false, headerButtons = null, resizable = true }) {
    this.resizable = resizable; // petites cartes : pas de −/+ (deux mains suffisent)
    this.headerButtons = headerButtons; // () => [{ id, icon, onClick, active }]
    this.bare = bare; // pas de verre ni de poignée : le panneau dessine tout
    LIVE_PANELS.add(this);
    this.closable = closable;
    this.onClose = onClose;
    this.title = title;
    this.drawContent = draw;
    this.handle = handle;
    this.radius = radius;
    this.scale = 1;
    this.zones = [];
    this.hoverId = null;
    this.pressedId = null;
    this.dirty = true;
    this.setSize(width, height);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Panneaux vus de biais : filtrage anisotrope maximal (16 sur le Quest).
    this.texture.anisotropy = maxAnisotropy;
    // Le panneau écrit la profondeur (ce qui est derrière, l'orbe comprise, est
    // masqué) ; l'alphaTest écarte les pixels vides — coins arrondis, marges.
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: true, alphaTest: 0.02 });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this.material);
    this.mesh.userData.panel = this;
    this.mesh.renderOrder = 2;
    this.object = new THREE.Group();
    this.object.add(this.mesh);
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    this.canvas = this.canvas || document.createElement("canvas");
    this.lw = Math.round(width * PX_PER_M);
    this.lh = Math.round(height * PX_PER_M);
    this.canvas.width = Math.max(2, Math.round(this.lw * density));
    this.canvas.height = Math.max(2, Math.round(this.lh * density));
    this.ctx = this.canvas.getContext("2d");
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = new THREE.PlaneGeometry(width, height);
      this.texture.dispose();
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.anisotropy = maxAnisotropy;
      this.material.map = this.texture;
    }
    this.dirty = true;
  }

  get W() { return this.lw; }
  get H() { return this.lh; }

  /// Nouvelle densité : on recrée le canvas (et la texture) à la bonne taille.
  applyDensity() {
    this.canvas = document.createElement("canvas");
    this.setSize(this.width, this.height);
  }
  get handleH() { return this.handle ? 86 : 0; }

  /// Déclare une zone cliquable pendant le dessin.
  zone(id, x, y, w, h, onClick, opts = {}) {
    this.zones.push({ id, x, y, w, h, onClick, ...opts });
    return this.hoverId === id;
  }

  invalidate() { this.dirty = true; }

  render() {
    if (!this.dirty) return;
    this.dirty = false;
    // Couche WebXR native éventuelle (xr-layers.js) : à recopier.
    this.layerDirty = true;
    const { ctx, W, H } = this;
    this.zones = [];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(density, 0, 0, density, 0, 0);
    if (this.bare) {
      this.drawContent?.(ctx, this);
      this.texture.needsUpdate = true;
      return;
    }
    // Verre dépoli : dégradé + liseré, ombre douce intérieure.
    roundRect(ctx, 3, 3, W - 6, H - 6, this.radius);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, THEME.glassTop);
    g.addColorStop(0.18, THEME.glass);
    g.addColorStop(1, THEME.glass);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = THEME.stroke;
    ctx.stroke();

    if (this.handle) {
      // Poignée : barre centrale (saisir pour déplacer) + titre + taille.
      const grabbed = this.hoverId === "__handle" || this.pressedId === "__handle";
      ctx.fillStyle = grabbed ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.35)";
      roundRect(ctx, W / 2 - 70, 9, 140, 10, 5); // au-dessus des boutons de l'en-tête
      ctx.fill();
      if (this.title) {
        ctx.font = `600 34px ${FONT}`;
        ctx.fillStyle = THEME.dim;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        let title = this.title;
        const extra = (this.headerButtons?.() || []).length * 80;
        const room = W - (this.closable ? 80 : 0) - (this.resizable ? 180 : 20) - extra - 50;
        while (title.length > 1 && ctx.measureText(title).width > room) title = title.slice(0, -2) + "…";
        ctx.fillText(title, 40, 58);
      }
      const right = this.closable ? 80 : 0;
      const extras = this.headerButtons?.() || [];
      const base = this.resizable ? W - 180 - right : W - 20 - right; // abscisse du bouton −
      // Poignée sur TOUTE la largeur de l'en-tête, déclarée AVANT les boutons :
      // le test de zones part de la dernière déclarée, donc un bouton garde la
      // priorité et tout le reste (titre, barre centrale, marges) saisit le
      // panneau. Avant, la zone s'arrêtait avant la barre qu'on vise d'instinct.
      this.zones.push({ id: "__handle", x: 0, y: 0, w: W, h: this.handleH, drag: true });
      extras.forEach((b, i) => {
        this.iconButton(b.id, base - (extras.length - i) * 80, 26, 64, "", b.onClick, { icon: b.icon, active: b.active });
      });
      // Boutons −/+ : redimensionner le panneau (utile avec les mains) ; × : fermer.
      if (this.resizable) {
        this.iconButton("__smaller", W - 180 - right, 26, 64, "", () => this.resize(1 / 1.15), { icon: "minus" });
        this.iconButton("__bigger", W - 100 - right, 26, 64, "", () => this.resize(1.15), { icon: "plus" });
      }
      if (this.closable) this.iconButton("__close", W - 100, 26, 64, "", () => this.close(), { icon: "x", hoverColor: "rgba(255,84,112,0.75)" });
    }
    ctx.save();
    ctx.translate(0, this.handleH);
    this.drawContent?.(ctx, this);
    ctx.restore();
    // Les zones du contenu sont déclarées dans le repère translaté.
    for (const z of this.zones) if (z._content) z.y += this.handleH;
    this.texture.needsUpdate = true;
  }

  /// Bouton rond (icône ou texte court) — utilisable depuis `draw`.
  iconButton(id, x, y, size, label, onClick, { active = false, color = null, inContent = false, hoverColor = null, icon = null } = {}) {
    const ctx = this.ctx;
    const hover = this.hoverId === id;
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = active ? (color || THEME.accent) : hover ? (hoverColor || "rgba(255,255,255,0.28)") : "rgba(255,255,255,0.12)";
    ctx.fill();
    if (icon) {
      const s = size * 0.5;
      drawIcon(ctx, icon, x + (size - s) / 2, y + (size - s) / 2, s, THEME.text, 2.25);
    } else {
      ctx.fillStyle = THEME.text;
      ctx.font = `500 ${Math.round(size * 0.52)}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + size / 2, y + size / 2 + 2);
    }
    this.zones.push({ id, x, y, w: size, h: size, onClick, _content: inContent });
  }

  /// Bouton « pilule » avec libellé — utilisable depuis `draw`.
  pill(id, x, y, w, h, label, onClick, { active = false, color = null, sub = "" } = {}) {
    const ctx = this.ctx;
    const hover = this.hoverId === id;
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = active ? (color || THEME.accent) : hover ? "rgba(255,255,255,0.26)" : "rgba(255,255,255,0.11)";
    ctx.fill();
    ctx.fillStyle = THEME.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Police réduite jusqu'à ce que le libellé tienne dans la pilule.
    let fs = Math.round(h * 0.34);
    ctx.font = `600 ${fs}px ${FONT}`;
    while (fs > 14 && ctx.measureText(label).width > w - 24) { fs -= 2; ctx.font = `600 ${fs}px ${FONT}`; }
    ctx.fillText(label, x + w / 2, y + h / 2 - (sub ? 12 : 0) + 2);
    if (sub) {
      ctx.font = `400 ${Math.round(h * 0.22)}px ${FONT}`;
      ctx.fillStyle = THEME.dim;
      ctx.fillText(sub, x + w / 2, y + h / 2 + 22);
    }
    this.zones.push({ id, x, y, w, h, onClick, _content: true });
  }

  get visible() { return this.object.visible; }

  open() { this.object.visible = true; this.openedAt = performance.now(); this.dirty = true; }

  close() {
    this.object.visible = false;
    this.hoverId = null;
    this.onClose?.(this);
  }

  resize(f) {
    this.scale = Math.min(2.2, Math.max(0.5, this.scale * f));
    this.object.scale.setScalar(this.scale);
  }

  /// Point du monde → { uv, depth } dans le plan du panneau (depth > 0 devant),
  /// ou null hors du rectangle. Sert au « poke » du bout du doigt.
  localHit(worldPoint) {
    const v = this.mesh.worldToLocal(worldPoint.clone());
    const hw = this.width / 2, hh = this.height / 2;
    if (Math.abs(v.x) > hw || Math.abs(v.y) > hh) return null;
    // L'échelle du panneau étire aussi l'axe z : on la retire de la profondeur.
    return { uv: { x: (v.x + hw) / this.width, y: (v.y + hh) / this.height }, depth: v.z * this.scale };
  }

  /// UV (0..1, origine en bas à gauche) → zone sous le pointeur.
  hitTest(uv) {
    const x = uv.x * this.W;
    const y = (1 - uv.y) * this.H;
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return z;
    }
    return null;
  }

  setHover(id) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.dirty = true;
  }
}
