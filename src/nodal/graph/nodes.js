// Catalogue des nœuds du mode « Nœuds » du Canevas — à la manière de ComfyUI :
// des ports TYPÉS (texte, image, nombre, charte, audio), des widgets dans le
// corps du nœud, et une fonction `run` pure qui reçoit les entrées résolues.
//
// Une entrée peut doubler un widget (`widget: "prompt"`) : non reliée, c'est
// la valeur du widget qui sert ; reliée, le lien l'emporte — comme « convertir
// un widget en entrée » dans ComfyUI, sans l'étape de conversion.
//
// Valeur IMAGE : { url: data URL, path?: chemin dans la sandbox du projet, w, h }.

import { generateText, generateImage, generateCharte, generateJingle, generateMusicSpec, generateVision } from "../../canvas/generate.js";

import { AI_DEFS, MODEL_WIDGETS } from "./ai-nodes.js";
import { LUMEN_DEFS } from "./lumen-nodes.js";
import { desktopAI } from "./ai-desktop.js";

export const TYPES = {
  MODEL: { label: "Modèle", color: "#8b5cf6" },
  TOOL: { label: "Outil", color: "#14b8a6" },
  JSON: { label: "JSON", color: "#6366f1" },
  TEXT: { label: "Texte", color: "#f5b942" },
  IMAGE: { label: "Image", color: "#5aa9f6" },
  NUMBER: { label: "Nombre", color: "#9bd53f" },
  CHARTE: { label: "Charte", color: "#f06bb5" },
  AUDIO: { label: "Audio", color: "#b98cff" },
  ANY: { label: "Tout", color: "#9ca3af" },
};
export const compatible = (from, to) => from === to || to === "ANY" || from === "ANY";

export const CATEGORIES = [
  { id: "memory", label: "Mémoire · lecture & écriture" },
  { id: "database", label: "Bases de données" },
  { id: "knowledge", label: "Documents & connaissances" },
  { id: "lumen", label: "Services Lumen" },
  { id: "home", label: "Domotique" },
  { id: "agents", label: "Assistants & modèles" },
  { id: "tools", label: "Outils & Fluxo" },
  { id: "logic", label: "Données & logique" },
  { id: "input", label: "Entrées" },
  { id: "text", label: "Texte & IA" },
  { id: "image", label: "Image IA" },
  { id: "imgops", label: "Traitement d'image" },
  { id: "vision", label: "Vision" },
  { id: "design", label: "Design" },
  { id: "audio", label: "Audio" },
  { id: "util", label: "Utilitaires" },
  { id: "output", label: "Sorties" },
];

// ---- Images (canvas 2D, local) ------------------------------------------------
export function loadImg(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("Image illisible."));
    im.src = src;
  });
}
function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
const out = (c) => ({ url: c.toDataURL("image/png"), w: c.width, h: c.height });
async function imgOf(v) {
  if (!v?.url) throw new Error("Aucune image en entrée.");
  return loadImg(v.url);
}
const need = (v, name) => { if (v == null || v === "") throw new Error(`Entrée « ${name} » vide.`); return v; };

// ---- Définitions -------------------------------------------------------------------
const D = [...AI_DEFS, ...LUMEN_DEFS];
const def = (d) => D.push(d);

// ── Entrées
def({ type: "text", title: "Texte", cat: "input", outputs: [{ name: "texte", type: "TEXT" }],
  widgets: [{ name: "text", kind: "textarea", label: "Texte", default: "" }],
  run: (i, w) => [w.text || ""] });
def({ type: "number", title: "Nombre", cat: "input", outputs: [{ name: "nombre", type: "NUMBER" }],
  widgets: [{ name: "value", kind: "number", label: "Valeur", default: 1, step: 0.1 }],
  run: (i, w) => [Number(w.value) || 0] });
def({ type: "seed", title: "Graine", cat: "input", outputs: [{ name: "graine", type: "NUMBER" }],
  widgets: [{ name: "seed", kind: "seed", label: "Graine", default: 42 }],
  run: (i, w) => [Number(w.seed) || 0] });
def({ type: "color", title: "Couleur", cat: "input", outputs: [{ name: "couleur", type: "TEXT" }],
  widgets: [{ name: "color", kind: "color", label: "Couleur", default: "#5e5ce6" }],
  run: (i, w) => [w.color] });
def({ type: "list", title: "Liste (une ligne = une variante)", cat: "input", outputs: [{ name: "ligne", type: "TEXT" }, { name: "tout", type: "TEXT" }],
  widgets: [{ name: "lines", kind: "textarea", label: "Lignes", default: "aube dorée\nnuit bleutée\nbrume matinale" }, { name: "index", kind: "number", label: "Ligne utilisée", default: 0, min: 0, step: 1, control: true }],
  run: (i, w) => { const ls = String(w.lines || "").split("\n").map((s) => s.trim()).filter(Boolean); if (!ls.length) return ["", ""]; return [ls[(Number(w.index) || 0) % ls.length], ls.join("\n")]; } });
def({ type: "image_load", title: "Charger une image", cat: "input", outputs: [{ name: "image", type: "IMAGE" }],
  widgets: [{ name: "file", kind: "file", label: "Image" }],
  run: async (i, w, ctx) => [await ctx.loadImageFile(need(w.file, "image"))] });

// ── Texte & IA
def({ type: "llm_text", title: "Générer du texte", cat: "text", heavy: true,
  inputs: [{ name: "consigne", type: "TEXT", widget: "prompt" }, { name: "contexte", type: "TEXT", optional: true }],
  outputs: [{ name: "texte", type: "TEXT" }],
  widgets: [{ name: "prompt", kind: "textarea", label: "Consigne", default: "Écris trois idées de slogans pour…" }],
  run: async (i, w, ctx) => { const r = await desktopAI(ctx.invoke).chat([{ role: "system", content: i.contexte || "Tu es un assistant utile." }, { role: "user", content: need(i.consigne, "consigne") }], w); return [r.content || ""]; } });
def({ type: "prompt_enhance", title: "Améliorer un prompt d'image", cat: "text", heavy: true,
  inputs: [{ name: "idée", type: "TEXT", widget: "idea" }, { name: "style", type: "TEXT", optional: true }],
  outputs: [{ name: "prompt", type: "TEXT" }],
  widgets: [{ name: "idea", kind: "textarea", label: "Idée", default: "un renard dans une forêt" }, { name: "lang", kind: "select", label: "Langue du prompt", options: [["en", "Anglais"], ["fr", "Français"]], default: "en" }],
  run: async (i, w) => {
    const ask = `Transforme cette idée en UN prompt de génération d'image détaillé (sujet, composition, lumière, matières, style, cadrage), ${w.lang === "fr" ? "en français" : "in English"}, une seule phrase longue, sans guillemets ni commentaire.\nIdée : ${need(i["idée"], "idée")}${i.style ? `\nStyle imposé : ${i.style}` : ""}`;
    const r = await generateText(ask, "", w);
    return [String(r.content || "").replace(/^["«\s]+|["»\s]+$/g, "").trim()];
  } });
def({ type: "translate", title: "Traduire", cat: "text", heavy: true,
  inputs: [{ name: "texte", type: "TEXT" }], outputs: [{ name: "traduction", type: "TEXT" }],
  widgets: [{ name: "to", kind: "select", label: "Vers", options: [["anglais", "Anglais"], ["français", "Français"], ["espagnol", "Espagnol"], ["allemand", "Allemand"], ["italien", "Italien"]], default: "anglais" }],
  run: async (i, w) => [(await generateText(`Traduis en ${w.to}, sans commentaire :\n\n${need(i.texte, "texte")}`, "", w)).content || ""] });
def({ type: "summarize", title: "Résumer", cat: "text", heavy: true,
  inputs: [{ name: "texte", type: "TEXT" }], outputs: [{ name: "résumé", type: "TEXT" }],
  widgets: [{ name: "len", kind: "select", label: "Longueur", options: [["1 phrase", "1 phrase"], ["3 puces", "3 puces"], ["un paragraphe", "Paragraphe"]], default: "3 puces" }],
  run: async (i, w) => [(await generateText(`Résume en ${w.len} :\n\n${need(i.texte, "texte")}`, "", w)).content || ""] });
def({ type: "concat", title: "Concaténer", cat: "text",
  inputs: [{ name: "a", type: "TEXT", optional: true }, { name: "b", type: "TEXT", optional: true }, { name: "c", type: "TEXT", optional: true }],
  outputs: [{ name: "texte", type: "TEXT" }],
  widgets: [{ name: "sep", kind: "text", label: "Séparateur", default: ", " }],
  run: (i, w) => [[i.a, i.b, i.c].filter((x) => x != null && x !== "").join(w.sep ?? ", ")] });
def({ type: "template", title: "Gabarit de texte", cat: "text",
  inputs: [{ name: "a", type: "TEXT", optional: true }, { name: "b", type: "TEXT", optional: true }, { name: "n", type: "NUMBER", optional: true }],
  outputs: [{ name: "texte", type: "TEXT" }],
  widgets: [{ name: "tpl", kind: "textarea", label: "Gabarit ({a}, {b}, {n})", default: "Affiche pour {a}, ambiance {b}" }],
  run: (i, w) => [String(w.tpl || "").replace(/\{a\}/g, i.a ?? "").replace(/\{b\}/g, i.b ?? "").replace(/\{n\}/g, i.n ?? "")] });

// ── Image IA
def({ type: "image_gen", title: "Générer une image", cat: "image", heavy: true,
  inputs: [{ name: "prompt", type: "TEXT", widget: "prompt" }, { name: "contexte", type: "TEXT", optional: true }, { name: "graine", type: "NUMBER", optional: true, widget: "seed" }],
  outputs: [{ name: "image", type: "IMAGE" }],
  widgets: [
    { name: "provider", kind: "select", label: "Moteur image", options: [["", "Moteur configuré"],["bonsai", "Bonsai"],["ollama", "Ollama"],["openai", "OpenAI"],["playground", "Image Playground"]], default: "" },
    { name: "model", kind: "text", label: "Modèle / style (vide = actif)", default: "" },
    { name: "prompt", kind: "textarea", label: "Prompt", default: "un phare au coucher du soleil, peinture à l'huile" },
    { name: "width", kind: "select", label: "Largeur", options: [[512, "512"], [768, "768"], [1024, "1024"]], default: 512 },
    { name: "height", kind: "select", label: "Hauteur", options: [[512, "512"], [768, "768"], [1024, "1024"]], default: 512 },
    { name: "steps", kind: "slider", label: "Étapes", default: 4, min: 1, max: 30, step: 1 },
    { name: "seed", kind: "seed", label: "Graine", default: 1234 },
  ],
  run: async (i, w, ctx) => {
    const path = ctx.outPath(`gen-${Date.now().toString(36)}.png`);
    const r = await generateImage({ provider: w.provider, model: w.model, prompt: need(i.prompt, "prompt"), context: i.contexte || "", width: Number(w.width) || 512, height: Number(w.height) || 512, steps: Number(w.steps) || 4, seed: i.graine ?? w.seed, sandboxId: ctx.sandboxId, path });
    return [{ url: r.url, path: r.path || path, w: Number(w.width) || 512, h: Number(w.height) || 512, backend: r.backend }];
  } });

// ── Traitement d'image (local, instantané)
def({ type: "img_resize", title: "Redimensionner", cat: "imgops", inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "image", type: "IMAGE" }],
  widgets: [{ name: "mode", kind: "select", label: "Mode", options: [["scale", "Échelle"], ["width", "Largeur fixe"], ["cover", "Recadrer au format"]], default: "scale" }, { name: "scale", kind: "slider", label: "Échelle", default: 2, min: 0.1, max: 4, step: 0.1 }, { name: "width", kind: "number", label: "Largeur", default: 1080 }, { name: "height", kind: "number", label: "Hauteur", default: 1080 }],
  run: async (i, w) => {
    const im = await imgOf(i.image);
    let W = im.width * (Number(w.scale) || 1), H = im.height * (Number(w.scale) || 1);
    if (w.mode === "width") { W = Number(w.width) || im.width; H = (im.height * W) / im.width; }
    if (w.mode === "cover") { W = Number(w.width) || im.width; H = Number(w.height) || im.height; }
    const c = canvasOf(W, H); const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    if (w.mode === "cover") { const s = Math.max(W / im.width, H / im.height); g.drawImage(im, (W - im.width * s) / 2, (H - im.height * s) / 2, im.width * s, im.height * s); }
    else g.drawImage(im, 0, 0, W, H);
    return [out(c)];
  } });
def({ type: "img_crop", title: "Recadrer", cat: "imgops", inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "image", type: "IMAGE" }],
  widgets: [{ name: "x", kind: "slider", label: "Gauche %", default: 0, min: 0, max: 90, step: 1 }, { name: "y", kind: "slider", label: "Haut %", default: 0, min: 0, max: 90, step: 1 }, { name: "w", kind: "slider", label: "Largeur %", default: 100, min: 5, max: 100, step: 1 }, { name: "h", kind: "slider", label: "Hauteur %", default: 100, min: 5, max: 100, step: 1 }],
  run: async (i, w) => {
    const im = await imgOf(i.image);
    const sx = (im.width * w.x) / 100, sy = (im.height * w.y) / 100;
    const sw = Math.min(im.width - sx, (im.width * w.w) / 100), sh = Math.min(im.height - sy, (im.height * w.h) / 100);
    const c = canvasOf(sw, sh); c.getContext("2d").drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
    return [out(c)];
  } });
def({ type: "img_transform", title: "Pivoter / miroir", cat: "imgops", inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "image", type: "IMAGE" }],
  widgets: [{ name: "rot", kind: "select", label: "Rotation", options: [[0, "0°"], [90, "90°"], [180, "180°"], [270, "270°"]], default: 0 }, { name: "flipH", kind: "toggle", label: "Miroir horizontal", default: false }, { name: "flipV", kind: "toggle", label: "Miroir vertical", default: false }],
  run: async (i, w) => {
    const im = await imgOf(i.image);
    const r = Number(w.rot) || 0, swap = r === 90 || r === 270;
    const c = canvasOf(swap ? im.height : im.width, swap ? im.width : im.height); const g = c.getContext("2d");
    g.translate(c.width / 2, c.height / 2); g.rotate((r * Math.PI) / 180); g.scale(w.flipH ? -1 : 1, w.flipV ? -1 : 1);
    g.drawImage(im, -im.width / 2, -im.height / 2);
    return [out(c)];
  } });
def({ type: "img_adjust", title: "Réglages couleur", cat: "imgops", inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "image", type: "IMAGE" }],
  widgets: [{ name: "brightness", kind: "slider", label: "Luminosité", default: 100, min: 0, max: 200, step: 1 }, { name: "contrast", kind: "slider", label: "Contraste", default: 100, min: 0, max: 200, step: 1 }, { name: "saturate", kind: "slider", label: "Saturation", default: 100, min: 0, max: 300, step: 1 }, { name: "hue", kind: "slider", label: "Teinte (°)", default: 0, min: -180, max: 180, step: 1 }, { name: "blur", kind: "slider", label: "Flou (px)", default: 0, min: 0, max: 30, step: 0.5 }, { name: "grayscale", kind: "slider", label: "Noir et blanc %", default: 0, min: 0, max: 100, step: 1 }, { name: "sepia", kind: "slider", label: "Sépia %", default: 0, min: 0, max: 100, step: 1 }],
  run: async (i, w) => {
    const im = await imgOf(i.image);
    const c = canvasOf(im.width, im.height); const g = c.getContext("2d");
    const f = `brightness(${w.brightness}%) contrast(${w.contrast}%) saturate(${w.saturate}%) hue-rotate(${w.hue}deg) blur(${w.blur}px) grayscale(${w.grayscale}%) sepia(${w.sepia}%)`;
    if ("filter" in g) { g.filter = f; g.drawImage(im, 0, 0); g.filter = "none"; }
    else {
      g.drawImage(im, 0, 0);
      // Repli sans `ctx.filter` : luminosité, contraste, saturation au pixel.
      const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
      const b = w.brightness / 100, ct = w.contrast / 100, s = w.saturate / 100, gs = w.grayscale / 100;
      for (let k = 0; k < p.length; k += 4) {
        let r = p[k] * b, gg = p[k + 1] * b, bb = p[k + 2] * b;
        r = (r - 128) * ct + 128; gg = (gg - 128) * ct + 128; bb = (bb - 128) * ct + 128;
        const l = 0.299 * r + 0.587 * gg + 0.114 * bb;
        r = l + (r - l) * s; gg = l + (gg - l) * s; bb = l + (bb - l) * s;
        r = r + (l - r) * gs; gg = gg + (l - gg) * gs; bb = bb + (l - bb) * gs;
        p[k] = r; p[k + 1] = gg; p[k + 2] = bb;
      }
      g.putImageData(d, 0, 0);
    }
    return [out(c)];
  } });
def({ type: "img_invert", title: "Inverser les couleurs", cat: "imgops", inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "image", type: "IMAGE" }],
  run: async (i) => { const im = await imgOf(i.image); const c = canvasOf(im.width, im.height); const g = c.getContext("2d"); g.drawImage(im, 0, 0); g.globalCompositeOperation = "difference"; g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); return [out(c)]; } });
def({ type: "img_blend", title: "Fusionner deux images", cat: "imgops", inputs: [{ name: "fond", type: "IMAGE" }, { name: "dessus", type: "IMAGE" }], outputs: [{ name: "image", type: "IMAGE" }],
  widgets: [{ name: "mode", kind: "select", label: "Mode", options: [["source-over", "Normal"], ["multiply", "Produit"], ["screen", "Superposition claire"], ["overlay", "Incrustation"], ["soft-light", "Lumière douce"], ["difference", "Différence"], ["color", "Couleur"], ["luminosity", "Luminosité"]], default: "overlay" }, { name: "opacity", kind: "slider", label: "Opacité %", default: 60, min: 0, max: 100, step: 1 }],
  run: async (i, w) => {
    const a = await imgOf(i.fond), b = await imgOf(i.dessus);
    const c = canvasOf(a.width, a.height); const g = c.getContext("2d");
    g.drawImage(a, 0, 0); g.globalAlpha = w.opacity / 100; g.globalCompositeOperation = w.mode;
    const s = Math.max(a.width / b.width, a.height / b.height); g.drawImage(b, (a.width - b.width * s) / 2, (a.height - b.height * s) / 2, b.width * s, b.height * s);
    return [out(c)];
  } });
def({ type: "img_composite", title: "Incruster (image dans l'image)", cat: "imgops", inputs: [{ name: "fond", type: "IMAGE" }, { name: "dessus", type: "IMAGE" }], outputs: [{ name: "image", type: "IMAGE" }],
  widgets: [{ name: "x", kind: "slider", label: "Position X %", default: 70, min: 0, max: 100, step: 1 }, { name: "y", kind: "slider", label: "Position Y %", default: 70, min: 0, max: 100, step: 1 }, { name: "scale", kind: "slider", label: "Taille %", default: 30, min: 5, max: 100, step: 1 }, { name: "radius", kind: "slider", label: "Arrondi", default: 12, min: 0, max: 200, step: 1 }],
  run: async (i, w) => {
    const a = await imgOf(i.fond), b = await imgOf(i.dessus);
    const c = canvasOf(a.width, a.height); const g = c.getContext("2d");
    g.drawImage(a, 0, 0);
    const bw = (a.width * w.scale) / 100, bh = (b.height * bw) / b.width;
    const x = ((a.width - bw) * w.x) / 100, y = ((a.height - bh) * w.y) / 100;
    g.save(); g.beginPath(); g.roundRect ? g.roundRect(x, y, bw, bh, w.radius) : g.rect(x, y, bw, bh); g.clip(); g.drawImage(b, x, y, bw, bh); g.restore();
    return [out(c)];
  } });
def({ type: "img_text", title: "Ajouter du texte", cat: "imgops", inputs: [{ name: "image", type: "IMAGE" }, { name: "texte", type: "TEXT", widget: "text" }, { name: "couleur", type: "TEXT", optional: true, widget: "color" }], outputs: [{ name: "image", type: "IMAGE" }],
  widgets: [{ name: "text", kind: "text", label: "Texte", default: "Titre" }, { name: "size", kind: "slider", label: "Taille %", default: 9, min: 2, max: 30, step: 0.5 }, { name: "color", kind: "color", label: "Couleur", default: "#ffffff" }, { name: "pos", kind: "select", label: "Position", options: [["top", "Haut"], ["center", "Centre"], ["bottom", "Bas"]], default: "bottom" }, { name: "font", kind: "select", label: "Police", options: [["-apple-system, Segoe UI, sans-serif", "Sans"], ["Georgia, serif", "Serif"], ["Impact, Arial Narrow, sans-serif", "Condensée"], ["ui-monospace, Menlo, monospace", "Machine"]], default: "-apple-system, Segoe UI, sans-serif" }, { name: "shadow", kind: "toggle", label: "Ombre", default: true }],
  run: async (i, w) => {
    const im = await imgOf(i.image);
    const c = canvasOf(im.width, im.height); const g = c.getContext("2d");
    g.drawImage(im, 0, 0);
    const size = (Math.min(c.width, c.height) * w.size) / 100;
    g.font = `800 ${size}px ${w.font}`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = i.couleur || w.color;
    if (w.shadow) { g.shadowColor = "rgba(0,0,0,.6)"; g.shadowBlur = size * 0.25; }
    const words = String(i.texte ?? w.text).split(/\s+/); const lines = []; let line = "";
    for (const wd of words) { const t = line ? `${line} ${wd}` : wd; if (g.measureText(t).width > c.width * 0.88 && line) { lines.push(line); line = wd; } else line = t; }
    lines.push(line);
    const lh = size * 1.15, bh = lines.length * lh;
    const y0 = w.pos === "top" ? c.height * 0.08 : w.pos === "center" ? (c.height - bh) / 2 : c.height * 0.92 - bh;
    lines.forEach((l, k) => g.fillText(l, c.width / 2, y0 + lh * k + lh / 2));
    return [out(c)];
  } });
def({ type: "img_vignette", title: "Vignette et grain", cat: "imgops", inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "image", type: "IMAGE" }],
  widgets: [{ name: "vignette", kind: "slider", label: "Vignette %", default: 45, min: 0, max: 100, step: 1 }, { name: "grain", kind: "slider", label: "Grain %", default: 10, min: 0, max: 60, step: 1 }],
  run: async (i, w) => {
    const im = await imgOf(i.image); const c = canvasOf(im.width, im.height); const g = c.getContext("2d");
    g.drawImage(im, 0, 0);
    if (w.grain > 0) { const d = g.getImageData(0, 0, c.width, c.height), p = d.data, a = w.grain * 1.2; for (let k = 0; k < p.length; k += 4) { const n = (Math.random() - 0.5) * a; p[k] += n; p[k + 1] += n; p[k + 2] += n; } g.putImageData(d, 0, 0); }
    const r = Math.hypot(c.width, c.height) / 2; const grad = g.createRadialGradient(c.width / 2, c.height / 2, r * 0.35, c.width / 2, c.height / 2, r);
    grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, `rgba(0,0,0,${w.vignette / 100})`); g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
    return [out(c)];
  } });
def({ type: "img_grid", title: "Planche (grille d'images)", cat: "imgops", inputs: [{ name: "a", type: "IMAGE" }, { name: "b", type: "IMAGE", optional: true }, { name: "c", type: "IMAGE", optional: true }, { name: "d", type: "IMAGE", optional: true }], outputs: [{ name: "planche", type: "IMAGE" }],
  widgets: [{ name: "gap", kind: "slider", label: "Marge", default: 12, min: 0, max: 80, step: 1 }, { name: "bg", kind: "color", label: "Fond", default: "#ffffff" }],
  run: async (i, w) => {
    const ims = await Promise.all([i.a, i.b, i.c, i.d].filter(Boolean).map(imgOf));
    const cell = 512, cols = ims.length > 1 ? 2 : 1, rows = Math.ceil(ims.length / cols), gp = Number(w.gap) || 0;
    const c = canvasOf(cols * cell + (cols + 1) * gp, rows * cell + (rows + 1) * gp); const g = c.getContext("2d");
    g.fillStyle = w.bg; g.fillRect(0, 0, c.width, c.height);
    ims.forEach((im, k) => { const x = gp + (k % cols) * (cell + gp), y = gp + Math.floor(k / cols) * (cell + gp); const s = Math.max(cell / im.width, cell / im.height); g.save(); g.beginPath(); g.rect(x, y, cell, cell); g.clip(); g.drawImage(im, x + (cell - im.width * s) / 2, y + (cell - im.height * s) / 2, im.width * s, im.height * s); g.restore(); });
    return [out(c)];
  } });
def({ type: "img_palette", title: "Extraire la palette", cat: "imgops", inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "couleurs", type: "TEXT" }, { name: "dominante", type: "TEXT" }],
  widgets: [{ name: "n", kind: "slider", label: "Couleurs", default: 5, min: 2, max: 8, step: 1 }],
  run: async (i, w) => {
    const im = await imgOf(i.image); const c = canvasOf(64, 64); const g = c.getContext("2d"); g.drawImage(im, 0, 0, 64, 64);
    const p = g.getImageData(0, 0, 64, 64).data; const bins = new Map();
    for (let k = 0; k < p.length; k += 4) { const key = ((p[k] >> 5) << 6) | ((p[k + 1] >> 5) << 3) | (p[k + 2] >> 5); const b = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += p[k]; b.g += p[k + 1]; b.b += p[k + 2]; bins.set(key, b); }
    const hex = (b) => `#${[b.r, b.g, b.b].map((v) => Math.round(v / b.n).toString(16).padStart(2, "0")).join("")}`;
    const top = [...bins.values()].sort((a, b) => b.n - a.n).slice(0, Number(w.n) || 5).map(hex);
    return [top.join(", "), top[0] || "#000000"];
  } });

// ── Vision
def({ type: "vision", title: "Décrire une image", cat: "vision", heavy: true,
  inputs: [{ name: "image", type: "IMAGE" }, { name: "question", type: "TEXT", optional: true, widget: "q" }], outputs: [{ name: "description", type: "TEXT" }],
  widgets: [{ name: "q", kind: "textarea", label: "Question", default: "" }],
  run: async (i,w) => { const b64 = String(need(i.image, "image").url).split(",")[1]; return [(await generateVision(i.question || "", b64, "", w)).content || ""]; } });
def({ type: "img2prompt", title: "Image → prompt", cat: "vision", heavy: true,
  inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "prompt", type: "TEXT" }],
  run: async (i,w) => { const b64 = String(need(i.image, "image").url).split(",")[1]; return [(await generateVision("Écris UN prompt de génération d'image (en anglais) qui reproduirait cette image : sujet, composition, lumière, palette, style, cadrage. Une seule phrase, sans commentaire.", b64, "", w)).content || ""]; } });

// ── Design
def({ type: "charte", title: "Charte graphique", cat: "design", heavy: true,
  inputs: [{ name: "brief", type: "TEXT", widget: "brief" }], outputs: [{ name: "charte", type: "CHARTE" }, { name: "couleurs", type: "TEXT" }],
  widgets: [{ name: "brief", kind: "textarea", label: "Brief", default: "café de quartier chaleureux, matières naturelles" }],
  run: async (i,w) => { const { charte } = await generateCharte(need(i.brief, "brief"), "", w); return [charte, charte.palette.map((c) => c.hex).join(", ")]; } });
def({ type: "poster", title: "Affiche / visuel", cat: "design",
  inputs: [{ name: "fond", type: "IMAGE", optional: true }, { name: "charte", type: "CHARTE", optional: true }, { name: "titre", type: "TEXT", widget: "title" }, { name: "sous-titre", type: "TEXT", optional: true, widget: "subtitle" }],
  outputs: [{ name: "affiche", type: "IMAGE" }],
  widgets: [{ name: "title", kind: "text", label: "Titre", default: "Grande ouverture" }, { name: "subtitle", kind: "text", label: "Sous-titre", default: "Samedi 10 h — entrée libre" }, { name: "cta", kind: "text", label: "Bouton", default: "Réserver" }, { name: "format", kind: "select", label: "Format", options: [["1080x1350", "Portrait 4:5"], ["1080x1920", "Story 9:16"], ["1080x1080", "Carré"], ["1920x1080", "Paysage"]], default: "1080x1350" }, { name: "layout", kind: "select", label: "Mise en page", options: [["bottom", "Texte en bas"], ["center", "Centré"], ["split", "Bandeau"]], default: "bottom" }],
  run: async (i, w) => {
    const [W, H] = String(w.format).split("x").map(Number);
    const c = canvasOf(W, H); const g = c.getContext("2d");
    const pal = i.charte?.palette?.map((p) => p.hex) || ["#111827", "#f5b942", "#ffffff"];
    const fH = i.charte?.fonts?.heading ? `'${i.charte.fonts.heading}', -apple-system, sans-serif` : "-apple-system, Segoe UI, sans-serif";
    const fB = i.charte?.fonts?.body ? `'${i.charte.fonts.body}', -apple-system, sans-serif` : "-apple-system, Segoe UI, sans-serif";
    g.fillStyle = pal[0]; g.fillRect(0, 0, W, H);
    if (i.fond) { const im = await imgOf(i.fond); const s = Math.max(W / im.width, (w.layout === "split" ? H * 0.62 : H) / im.height); g.drawImage(im, (W - im.width * s) / 2, 0, im.width * s, im.height * s); }
    if (w.layout !== "split") { const gr = g.createLinearGradient(0, H * 0.35, 0, H); gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(0,0,0,.72)"); g.fillStyle = gr; g.fillRect(0, 0, W, H); }
    else { g.fillStyle = pal[0]; g.fillRect(0, H * 0.62, W, H * 0.38); }
    const titleSize = W * 0.085, y0 = w.layout === "center" ? H * 0.42 : w.layout === "split" ? H * 0.70 : H * 0.70;
    g.textAlign = w.layout === "center" ? "center" : "left"; g.textBaseline = "top";
    const x = w.layout === "center" ? W / 2 : W * 0.08;
    g.fillStyle = pal.find((p, k) => k > 0) || "#ffffff";
    g.font = `800 ${titleSize}px ${fH}`;
    const title = String(i.titre ?? w.title);
    const words = title.split(/\s+/); const lines = []; let line = "";
    for (const wd of words) { const t = line ? `${line} ${wd}` : wd; if (g.measureText(t).width > W * 0.84 && line) { lines.push(line); line = wd; } else line = t; }
    lines.push(line);
    g.fillStyle = "#ffffff"; lines.forEach((l, k) => g.fillText(l, x, y0 + k * titleSize * 1.05));
    const yS = y0 + lines.length * titleSize * 1.05 + W * 0.02;
    g.font = `500 ${W * 0.036}px ${fB}`; g.fillStyle = "rgba(255,255,255,.88)"; g.fillText(String(i["sous-titre"] ?? w.subtitle), x, yS);
    if (w.cta) {
      g.font = `700 ${W * 0.034}px ${fB}`; const tw = g.measureText(w.cta).width, bw = tw + W * 0.07, bh = W * 0.075;
      const bx = w.layout === "center" ? W / 2 - bw / 2 : x, by = yS + W * 0.07;
      g.fillStyle = pal[1] || "#f5b942"; g.beginPath(); g.roundRect ? g.roundRect(bx, by, bw, bh, bh / 2) : g.rect(bx, by, bw, bh); g.fill();
      g.fillStyle = pal[0]; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(w.cta, bx + bw / 2, by + bh / 2);
    }
    return [out(c)];
  } });

// ── Audio
def({ type: "jingle", title: "Jingle (texte)", cat: "audio", heavy: true, inputs: [{ name: "sujet", type: "TEXT", widget: "topic" }], outputs: [{ name: "jingle", type: "TEXT" }],
  widgets: [{ name: "topic", kind: "textarea", label: "Sujet", default: "boulangerie bio du quartier" }],
  run: async (i,w) => [(await generateJingle(need(i.sujet, "sujet"), "", w)).content || ""] });
def({ type: "tts", title: "Voix (synthèse)", cat: "audio", heavy: true, inputs: [{ name: "texte", type: "TEXT" }], outputs: [{ name: "voix", type: "AUDIO" }],
  run: async (i, w, ctx) => { const b64 = await ctx.invoke("tts_synth_b64", { text: need(i.texte, "texte"), voice: null }); return [{ kind: "wav", url: `data:audio/wav;base64,${b64}` }]; } });
def({ type: "music", title: "Musique (boucle)", cat: "audio", heavy: true, inputs: [{ name: "ambiance", type: "TEXT", widget: "mood" }], outputs: [{ name: "musique", type: "AUDIO" }],
  widgets: [{ name: "mood", kind: "text", label: "Ambiance", default: "pop solaire et légère" }, { name: "seconds", kind: "slider", label: "Durée (s)", default: 12, min: 4, max: 40, step: 1 }],
  run: async (i, w) => { const { music } = await generateMusicSpec(need(i.ambiance, "ambiance"), "", "", { ...w, durationSec: Number(w.seconds) || 12 }); return [{ kind: "spec", spec: music }]; } });

// ── Utilitaires
def({ type: "reroute", title: "Relais", cat: "util", inputs: [{ name: "", type: "ANY" }], outputs: [{ name: "", type: "ANY" }], compact: true, run: (i) => [i[""]] });
def({ type: "switch", title: "Aiguillage", cat: "util", inputs: [{ name: "a", type: "ANY", optional: true }, { name: "b", type: "ANY", optional: true }], outputs: [{ name: "sortie", type: "ANY" }],
  widgets: [{ name: "pick", kind: "select", label: "Choix", options: [["a", "A"], ["b", "B"]], default: "a" }],
  run: (i, w) => [i[w.pick] ?? i.a ?? i.b] });
def({ type: "note", title: "Note", cat: "util", widgets: [{ name: "text", kind: "textarea", label: "", default: "Commentaire…" }], noRun: true, run: () => [] });

// ── Sorties
def({ type: "preview", title: "Aperçu", cat: "output", output: true, inputs: [{ name: "entrée", type: "ANY" }], run: (i) => [], preview: (i) => i["entrée"] });
def({ type: "save_image", title: "Enregistrer l'image", cat: "output", output: true, inputs: [{ name: "image", type: "IMAGE" }],
  widgets: [{ name: "prefix", kind: "text", label: "Nom", default: "canevas" }],
  run: async (i, w, ctx) => { const p = await ctx.saveImage(need(i.image, "image"), w.prefix || "canevas"); return []; }, preview: (i) => i.image });
def({ type: "save_text", title: "Enregistrer le texte", cat: "output", output: true, inputs: [{ name: "texte", type: "TEXT" }],
  widgets: [{ name: "name", kind: "text", label: "Nom", default: "texte" }],
  run: async (i, w, ctx) => { await ctx.saveText(need(i.texte, "texte"), w.name || "texte"); return []; }, preview: (i) => i.texte });

// Text generation blocks keep per-node model settings, including older projects.
for (const d of D) {
  if (['llm_text','prompt_enhance','translate','summarize','charte','vision','img2prompt','jingle','music'].includes(d.type)) {
    d.widgets = [...(d.widgets || []), ...MODEL_WIDGETS];
  }
}
export const nodeIcon = d => d.icon || ({ input: 'type', text: 'brain', image: 'image', imgops: 'image', vision: 'eye', design: 'palette', audio: 'audio-lines', util: 'settings', output: 'download' }[d.cat] || 'workflow');
export const nodeColor = d => ({ memory: '#a855f7', database: '#0284c7', knowledge: '#6366f1', lumen: '#059669', home: '#ea580c', agents: '#8b5cf6', tools: '#14b8a6', logic: '#6366f1', input: '#f59e0b', text: '#8b5cf6', image: '#3b82f6', imgops: '#0ea5e9', audio: '#ec4899', output: '#10b981' }[d.cat] || '#64748b');
export const NODE_DEFS = Object.fromEntries(D.map((d) => [d.type, { inputs: [], outputs: [], widgets: [], ...d }]));
export const nodeDef = (type) => NODE_DEFS[type];
