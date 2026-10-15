// Studio de montage de Médias — simple, mais complet, à la manière de CapCut :
// piste principale magnétique, incrustations, textes/légendes/stickers, pistes
// audio (musique, voix off, effets), transitions, filtres et réglages couleur,
// transformations et mouvements, sous-titres automatiques (Whisper local),
// suppression des silences, calage sur le rythme, voix off au micro ou de
// synthèse, annuler/rétablir, plusieurs projets — et un assistant IA qui pilote
// tout cela par ses outils (editor-ai.js).
//
// Lecture et export partagent le même moteur : les <video>/<audio> jouent
// réellement (un élément par clip, pour les transitions et les doublons), le
// rendu dessine chaque image dans le canvas (editor-render.js), et le son passe
// par un graphe WebAudio. L'export enregistre ce canvas et ce son en temps réel
// (MediaRecorder) : MP4 quand le moteur le sait, sinon WebM converti par ffmpeg.

import { tt } from "../apps-i18n.js";
import { confirmSheet } from "../lib/confirm.js";
import { icon } from "../lib/icons.js";
import { ensureSessionUnlocked, invokeUnlocked, isSessionUnlocked } from "../lib/session-unlock.js";
import * as M from "./editor-model.js";
import { ADJUSTMENTS, ASPECT_LABELS, FILTER_PRESETS, FONTS, MOTIONS, STICKERS, TEXT_ANIMS_IN, TEXT_ANIMS_OUT, TEXT_PRESETS, TRANSITIONS, filterFromPreset } from "./editor-catalog.js";
import { createRenderer } from "./editor-render.js";
import * as A from "./editor-analysis.js";
import { mountEditorAI } from "./editor-ai.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;
const fmt = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}.${Math.floor((s * 10) % 10)}`; };
const fmtShort = (s) => { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };
const even = (v) => Math.round(v / 2) * 2;
const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const LABEL = 92;
const ic = (n) => icon(n) || "";

export function mountEditor(ctx) {
  const { store, toast, mediaUrl, invoke } = ctx;

  // ===== Projets ============================================================
  let index = store.getJSON("projects", null);
  if (!Array.isArray(index)) {
    index = [];
    const legacy = store.getJSON("project", null);
    if (legacy) {
      const p = M.migrate(legacy);
      index.push({ id: p.id, title: p.title, updated: Date.now() });
      store.set(`project:${p.id}`, p);
      store.remove?.("project");
    }
  }
  let P = null;
  {
    const cur = store.get("current", index[0]?.id || "");
    const raw = cur ? store.getJSON(`project:${cur}`, null) : null;
    P = raw ? M.migrate(raw) : null;
    if (!P) { P = M.blankProject(tt("Mon montage")); index.unshift({ id: P.id, title: P.title, updated: Date.now() }); }
  }
  const hist = M.createHistory();
  let sel = null;          // { type: "clip"|"overlay"|"text"|"audio"|"transition", id }
  let inspTab = "";        // onglet de l'inspecteur
  let t = 0;               // tête de lecture (s)
  let playing = false;
  let pps = clamp(Number(store.get("pps", 60)) || 60, 8, 300);
  let snapOn = store.get("snap", "1") !== "0";
  let exporting = null;
  let boxes = [];
  let dragCat = "";        // catégorie en cours de déplacement (piste « + » visible)

  function save() {
    store.set(`project:${P.id}`, P);
    const e = index.find((x) => x.id === P.id);
    if (e) { e.title = P.title; e.updated = Date.now(); } else index.unshift({ id: P.id, title: P.title, updated: Date.now() });
    store.set("projects", index);
    store.set("current", P.id);
  }

  /** Toute modification passe par ici : historique, sauvegarde, rendu. */
  function change(fn, { keepSel = true } = {}) {
    hist.push(P);
    const out = fn(P);
    after(keepSel);
    return out;
  }
  function after(keepSel = true) {
    if (keepSel && sel && sel.type !== "transition" && !M.findItem(P, sel.id)) sel = null;
    if (sel?.type === "transition" && !P.clips.find((c) => c.id === sel.id)) sel = null;
    save(); gcEls(); renderTimeline(); renderInspector(); updateUndo();
    t = clamp(t, 0, M.total(P));
    seek(t);
  }

  // ===== Médias (un élément par clip) =======================================
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-20px;top:-20px;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none";
  document.body.appendChild(holder);
  const els = new Map();   // id d'élément → <video>/<audio>
  const imgs = new Map();  // source → <img>
  const keyOf = (src) => `${src.sandboxId}|${src.path}`;
  const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

  function imgFor(src) {
    const k = keyOf(src);
    if (imgs.has(k)) return imgs.get(k);
    // Images lues dans la sandbox (data: URL) : WebKit refuse une image d'un
    // schéma personnalisé en mode cross-origin, et sans ce mode le canvas
    // serait « sali » (export impossible).
    const el = new Image();
    const ext = String(src.path).split(".").pop().toLowerCase();
    if (window.__previewMediaUrl) el.src = mediaUrl(src);
    else invoke("sandbox_read_b64", { id: src.sandboxId, path: src.path })
      .then((b64) => { el.src = `data:${MIME[ext] || "image/png"};base64,${b64}`; })
      .catch(() => { el.crossOrigin = "anonymous"; el.src = mediaUrl(src); });
    el.addEventListener("load", () => { if (!playing) draw(); paintThumbs(); });
    imgs.set(k, el);
    return el;
  }
  function elFor(item) {
    let el = els.get(item.id);
    const k = keyOf(item.src);
    if (el && el._k === k) return el;
    if (el) dropEl(item.id);
    el = document.createElement(item.kind === "video" ? "video" : "audio");
    el.crossOrigin = "anonymous"; el.preload = "auto"; el.playsInline = true; el._k = k;
    el.src = mediaUrl(item.src);
    el.addEventListener("loadeddata", () => { if (!playing) draw(); });
    holder.appendChild(el);
    els.set(item.id, el);
    return el;
  }
  const mediaOf = (item) => (item.kind === "image" ? imgFor(item.src) : item.kind === "video" ? elFor(item) : null);
  function dropEl(id) {
    const el = els.get(id);
    if (!el) return;
    try { el.pause(); } catch {}
    gains.get(el)?.disconnect();
    gains.delete(el);
    el.removeAttribute("src"); try { el.load(); } catch {}
    el.remove();
    els.delete(id);
  }
  function gcEls() {
    const ids = new Set([...P.clips, ...P.overlays, ...P.audio].map((x) => x.id));
    for (const id of [...els.keys()]) if (!ids.has(id)) dropEl(id);
  }

  // ---- Son : graphe WebAudio --------------------------------------------------
  let ac = null, master = null, mixDest = null;
  const gains = new Map();
  function audio() {
    if (ac) return ac;
    ac = new AudioContext();
    master = ac.createGain(); master.connect(ac.destination);
    mixDest = ac.createMediaStreamDestination();
    return ac;
  }
  function gainFor(el) {
    audio();
    let gn = gains.get(el);
    if (gn) return gn;
    const s = ac.createMediaElementSource(el);
    gn = ac.createGain();
    s.connect(gn); gn.connect(master); gn.connect(mixDest);
    gains.set(el, gn);
    return gn;
  }

  // ===== Rendu ==============================================================
  const canvas = $("ed-canvas");
  const R = createRenderer(canvas, { getP: () => P, mediaOf });
  function dims(q) {
    const [a, b] = M.ASPECTS[P.aspect] || M.ASPECTS["16:9"];
    return a >= b ? [even((q * a) / b), even(q)] : [even(q), even((q * b) / a)];
  }
  function resize(full = false) {
    const [w, h] = dims(full ? P.quality : Math.min(P.quality, 720));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    fitCanvas();
    draw();
  }
  function fitCanvas() {
    const st = $("stage-ed");
    if (!st.clientWidth) return;
    const W = st.clientWidth - 28, H = st.clientHeight - 28;
    const r = canvas.width / canvas.height;
    let w = W, h = W / r;
    if (h > H) { h = H; w = H * r; }
    canvas.style.width = `${Math.max(40, w)}px`; canvas.style.height = `${Math.max(40, h)}px`;
    drawSel();
  }
  new ResizeObserver(fitCanvas).observe($("stage-ed"));

  function draw() {
    boxes = R.render(t, { editing: !playing });
    $("ed-time").textContent = `${fmt(t)} / ${fmt(M.total(P))}`;
    placePlayhead();
    drawSel();
  }

  // ===== Lecture ============================================================
  function syncEl(item, el, local, len, mul, force) {
    const inside = local >= 0 && local < len;
    if (!inside) {
      if (!el.paused) el.pause();
      // Pré-positionnement : le clip suivant est prêt quand on l'atteint.
      if (local < 0 && local > -1.2 && !el.seeking && Math.abs(el.currentTime - item.in) > 0.15) { try { el.currentTime = item.in; } catch {} }
      return;
    }
    const sp = item.speed || 1;
    const want = item.in + local * sp;
    if (force || Math.abs(el.currentTime - want) > 0.3) { try { el.currentTime = want; } catch {} }
    if (el.playbackRate !== sp) el.playbackRate = sp;
    if (ac) {
      const fade = Math.min(item.fadeIn ? local / item.fadeIn : 1, item.fadeOut ? (len - local) / item.fadeOut : 1);
      gainFor(el).gain.value = item.mute ? 0 : clamp(fade, 0, 1) * (item.volume ?? 1) * mul;
    }
    if (playing && el.paused) el.play().catch(() => {});
    if (!playing && !el.paused) el.pause();
  }
  function sync(force = false) {
    const s = M.clipStarts(P);
    P.clips.forEach((c, i) => {
      if (c.kind !== "video") return;
      const len = M.clipLen(c), local = t - s[i];
      // Fondu sonore croisé pendant les transitions.
      let mul = 1;
      const dIn = i > 0 ? M.transDur(P, i - 1) : 0;
      if (dIn && local < dIn) mul *= clamp(local / dIn, 0, 1);
      const dOut = M.transDur(P, i);
      if (dOut && local > len - dOut) mul *= clamp((len - local) / dOut, 0, 1);
      syncEl(c, elFor(c), local, len, mul, force);
    });
    for (const o of P.overlays) if (o.kind === "video") syncEl(o, elFor(o), t - o.start, M.clipLen(o), 1, force);
    for (const m of P.audio) syncEl(m, elFor(m), t - m.start, M.audioLen(m), 1, force);
  }

  let raf = 0, timer = 0, lastTs = 0;
  function loop(ts) {
    if (!playing) return;
    const dt = lastTs ? Math.min(0.25, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    // L'horloge suit la vidéo principale quand elle joue seule (pas de dérive).
    const hits = M.mainAt(P, t);
    if (hits.length === 1 && hits[0].clip.kind === "video") {
      const h = hits[0], el = elFor(h.clip);
      if (!el.paused && !el.seeking && el.readyState >= 2) {
        const nt = h.start + (el.currentTime - h.clip.in) / (h.clip.speed || 1);
        t = Math.abs(nt - t) < 0.5 ? Math.max(t, nt) : t + dt;
      } else t += dt;
      if (el.ended || el.currentTime >= h.clip.out - 0.02) t = Math.max(t, h.start + h.len);
    } else t += dt;
    const T = M.total(P);
    if (t >= T) {
      t = T;
      if (exporting) { exporting.finish(); return; }
      pause(); return;
    }
    sync();
    draw();
    if (exporting) exporting.progress(t / Math.max(0.01, T));
    else followPlayhead();
    schedule();
  }
  // Pendant un export, un minuteur à la cadence du projet plutôt que
  // requestAnimationFrame, qui s'arrête dès que la fenêtre passe derrière.
  function schedule() {
    if (exporting) timer = setTimeout(() => loop(performance.now()), 1000 / (P.fps || 30));
    else raf = requestAnimationFrame(loop);
  }
  function setPlayIcon() { $("ed-play").innerHTML = ic(playing ? "pause" : "play"); }
  function playFrom(time) {
    if (!M.total(P)) { toast(tt("Ajoutez d'abord des médias à la timeline.")); return; }
    audio().resume();
    t = clamp(time, 0, Math.max(0, M.total(P) - 0.03));
    playing = true; lastTs = 0;
    setPlayIcon();
    sync(true);
    schedule();
  }
  function pause() {
    playing = false;
    cancelAnimationFrame(raf); clearTimeout(timer);
    setPlayIcon();
    for (const el of els.values()) if (!el.paused) el.pause();
    draw();
  }
  function seek(time) {
    t = clamp(time, 0, M.total(P));
    sync(true);
    // Une vidéo arrêtée ne se redessine qu'une fois la nouvelle image décodée.
    for (const h of M.mainAt(P, t)) if (h.clip.kind === "video") elFor(h.clip).addEventListener("seeked", () => { if (!playing) draw(); }, { once: true });
    for (const o of P.overlays) if (o.kind === "video" && t >= o.start && t < o.start + M.clipLen(o)) elFor(o).addEventListener("seeked", () => { if (!playing) draw(); }, { once: true });
    draw();
  }
  function followPlayhead() {
    const tl = $("timeline");
    const x = LABEL + t * pps;
    if (x > tl.scrollLeft + tl.clientWidth - 40) tl.scrollLeft = x - LABEL - 60;
  }

  // ===== Ajout de médias ====================================================
  function probe(src, kind) {
    if (kind === "image") {
      const el = imgFor(src);
      return new Promise((resolve) => {
        if (el.complete && el.naturalWidth) resolve(5);
        else { el.addEventListener("load", () => resolve(5), { once: true }); el.addEventListener("error", () => resolve(0), { once: true }); setTimeout(() => resolve(el.naturalWidth ? 5 : 0), 8000); }
      });
    }
    return new Promise((resolve) => {
      const el = document.createElement(kind === "audio" ? "audio" : "video");
      el.preload = "metadata"; el.crossOrigin = "anonymous"; el.muted = true; el.src = mediaUrl(src);
      holder.appendChild(el);
      const done = (d) => { el.removeAttribute("src"); try { el.load(); } catch {} el.remove(); resolve(d); };
      // Les WebM enregistrés par un navigateur annoncent souvent une durée
      // infinie : on force le calcul en visant la fin du fichier.
      el.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(el.duration) && el.duration > 0) { done(el.duration); return; }
        el.addEventListener("seeked", () => done(Number.isFinite(el.duration) && el.duration > 0.05 ? el.duration : el.currentTime), { once: true });
        el.currentTime = 1e9;
      }, { once: true });
      el.addEventListener("error", () => done(0), { once: true });
      setTimeout(() => done(0), 20000);
    });
  }

  function indexAtTime(time) {
    const s = M.clipStarts(P);
    let i = 0;
    while (i < P.clips.length && s[i] + M.clipLen(P.clips[i]) / 2 < time) i++;
    return i;
  }

  /**
   * Ajoute un fichier de la bibliothèque. `opts` : { track: "main"|"overlay"|
   * "audio", at (s), index, audioKind, silent }. Renvoie l'élément créé.
   */
  async function add(f, opts = {}) {
    if (!f) return null;
    if (!f.playable) { toast(tt("Convertissez d'abord ce fichier (lecteur).")); return null; }
    if (!(await ensureSessionUnlocked({ invoke, reason: tt("Ajouter au montage") }))) return null;
    const src = { sandboxId: f.sandboxId, path: f.path, name: f.name };
    const d = await probe(src, f.kind);
    if (!d) { toast(tt("Média illisible.")); return null; }
    hist.push(P);
    let item;
    if (f.kind === "audio" || opts.track === "audio") {
      const start = opts.at ?? (opts.audioKind === "voice" ? t : 0);
      item = M.newAudio({ src, kind: opts.audioKind || "music", start, in: 0, out: d, srcDur: d });
      item.lane = opts.lane ?? M.freeLane(P.audio, item.start, item.start + M.audioLen(item), M.audioLen);
      P.audio.push(item);
      sel = { type: "audio", id: item.id };
    } else if (opts.track === "overlay") {
      const start = opts.at ?? t;
      item = M.newOverlay({ kind: f.kind, src, start, in: 0, out: f.kind === "video" ? d : 0, dur: f.kind === "image" ? 4 : 0, srcDur: d, transform: { scale: 0.42, x: 0.22, y: -0.2 } });
      item.lane = opts.lane ?? M.freeLane(P.overlays, start, start + M.clipLen(item), M.clipLen);
      P.overlays.push(item);
      sel = { type: "overlay", id: item.id };
    } else {
      item = M.newClip({ kind: f.kind, src, in: 0, out: f.kind === "video" ? d : 0, dur: f.kind === "image" ? (opts.dur || 4) : 0, srcDur: d, motion: f.kind === "image" ? "in" : "none" });
      const i = opts.index ?? (opts.at != null ? indexAtTime(opts.at) : P.clips.length);
      P.clips.splice(clamp(i, 0, P.clips.length), 0, item);
      sel = { type: "clip", id: item.id };
    }
    after();
    if (!opts.silent) toast(tt("« {n} » ajouté au montage.", { n: f.name }));
    return item;
  }

  function addColorClip(color = "#111827", dur = 3) {
    return change(() => {
      const c = M.newClip({ kind: "color", color, dur, fit: "cover" });
      const i = indexAtTime(t);
      P.clips.splice(i, 0, c);
      sel = { type: "clip", id: c.id };
      return c;
    });
  }

  function addText(opts = {}) {
    const preset = TEXT_PRESETS.find((p) => p.id === (opts.preset || "plain")) || TEXT_PRESETS[0];
    const start = opts.start ?? t;
    const dur = opts.dur ?? 3;
    return change(() => {
      const x = M.newText({ ...structuredClone(preset.s), preset: preset.id, text: opts.text ?? tt(preset.sample), start, end: opts.end ?? start + dur, ...(opts.patch || {}) });
      x.lane = opts.lane ?? M.freeLane(P.texts, x.start, x.end, (y) => y.end - y.start);
      P.texts.push(x);
      sel = { type: "text", id: x.id };
      inspTab = "text";
      return x;
    });
  }

  function addSticker(emoji) {
    return change(() => {
      const x = M.newText({ kind: "sticker", text: emoji, start: t, end: t + 3, size: 180, font: "sans", bg: "transparent", shadow: false, x: 0.5, y: 0.4, anim: { in: "pop", out: "pop", dur: 0.3 } });
      x.lane = M.freeLane(P.texts, x.start, x.end, (y) => y.end - y.start);
      P.texts.push(x);
      sel = { type: "text", id: x.id };
      return x;
    });
  }

  // ===== Outils ==============================================================
  function selected() { return sel && sel.type !== "transition" ? M.findItem(P, sel.id) : null; }

  function split(at = t) {
    const f = selected();
    // Élément libre sélectionné sous la tête de lecture : on le coupe, lui.
    if (f && f.type !== "clip") {
      const it = f.item;
      const sp = M.spanOf(P, it.id);
      if (at > sp.start + 0.05 && at < sp.end - 0.05) {
        return change(() => {
          const b = { ...structuredClone(it), id: M.uid(it.id[0]) };
          if (f.type === "text") { it.end = at; b.start = at; }
          else {
            const local = at - it.start, sp2 = it.speed || 1;
            if (it.kind === "image") { b.dur = it.dur - local; it.dur = local; }
            else { const cut = it.in + local * sp2; b.in = cut; it.out = cut; }
            b.start = at;
            it.fadeOut = 0; b.fadeIn = 0;
          }
          P[f.key].push(b);
          sel = { type: f.type, id: b.id };
        });
      }
    }
    const hit = M.clipAt(P, at);
    if (!hit) { toast(tt("Placez la tête de lecture sur un clip.")); return null; }
    const { clip, start, i } = hit;
    const local = at - start;
    if (local < 0.05 || M.clipLen(clip) - local < 0.05) return null;
    return change(() => {
      const b = { ...structuredClone(clip), id: M.uid() };
      if (clip.kind === "video") { const cut = clip.in + local * (clip.speed || 1); b.in = cut; clip.out = cut; }
      else { b.dur = clip.dur - local; clip.dur = local; }
      b.transition = clip.transition; clip.transition = null;
      clip.fadeOut = 0; b.fadeIn = 0;
      P.clips.splice(i + 1, 0, b);
      sel = { type: "clip", id: b.id };
      return b;
    });
  }

  function removeSelected() {
    if (!sel) return;
    if (sel.type === "transition") { change(() => { const c = P.clips.find((x) => x.id === sel.id); if (c) c.transition = null; sel = null; }); return; }
    const f = selected();
    if (!f) return;
    change(() => { P[f.key] = P[f.key].filter((x) => x.id !== sel.id); sel = null; });
  }
  function removeItems(ids) {
    const set = new Set(ids);
    change(() => { for (const k of ["clips", "overlays", "texts", "audio"]) P[k] = P[k].filter((x) => !set.has(x.id)); });
  }

  function duplicate() {
    const f = selected();
    if (!f) { toast(tt("Sélectionnez d'abord un élément.")); return; }
    change(() => {
      const b = { ...structuredClone(f.item), id: M.uid(f.item.id[0]) };
      if (f.type === "clip") P.clips.splice(P.clips.indexOf(f.item) + 1, 0, b);
      else {
        const sp = M.spanOf(P, f.item.id);
        const len = sp.end - sp.start;
        if (f.type === "text") { b.start = sp.end; b.end = sp.end + len; } else b.start = sp.end;
        P[f.key].push(b);
      }
      sel = { type: f.type, id: b.id };
    });
  }

  function toggleMarker() {
    change(() => {
      const near = P.markers.findIndex((m) => Math.abs(m - t) < 0.1);
      if (near >= 0) P.markers.splice(near, 1);
      else { P.markers.push(r2(t)); P.markers.sort((a, b) => a - b); }
    });
  }

  /** Détache le son d'un clip vidéo sur une piste audio (le clip devient muet). */
  function detachAudio() {
    const f = selected();
    const it = f?.item;
    if (!it || (f.type !== "clip" && f.type !== "overlay") || it.kind !== "video") { toast(tt("Sélectionnez un clip vidéo.")); return; }
    const sp = M.spanOf(P, it.id);
    change(() => {
      const a = M.newAudio({ kind: "voice", src: it.src, start: sp.start, in: it.in, out: it.out, speed: it.speed, volume: it.volume ?? 1, srcDur: it.srcDur });
      a.lane = M.freeLane(P.audio, a.start, a.start + M.audioLen(a), M.audioLen);
      P.audio.push(a);
      it.mute = true;
      sel = { type: "audio", id: a.id };
    });
    toast(tt("Audio détaché : il vit maintenant sur sa propre piste."));
  }

  // ---- Écriture binaire dans une sandbox -----------------------------------
  async function sandboxes() {
    try { return (await invokeUnlocked(invoke, "sandbox_list", {}, tt("Accéder à vos sandboxes"))) || []; } catch { return []; }
  }
  async function targetSandbox() {
    const list = await sandboxes();
    const pref = store.get("exportSandbox", "") || P.clips[0]?.src?.sandboxId || P.audio[0]?.src?.sandboxId;
    return list.find((s) => s.id === pref) || list.find((s) => /m[ée]dia|vid[ée]o|montage/i.test(s.name)) || list[0] || null;
  }
  async function writeBlob(sandboxId, path, blob, onProgress) {
    const CH = 3 * 1024 * 1024;
    for (let off = 0; off < blob.size || off === 0; off += CH) {
      const buf = new Uint8Array(await blob.slice(off, off + CH).arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      await invokeUnlocked(invoke, "media_append_b64", { sandboxId, path, dataB64: btoa(bin), reset: off === 0 }, tt("Enregistrer le fichier"));
      onProgress?.(Math.min(1, (off + CH) / Math.max(1, blob.size)));
      if (!blob.size) break;
    }
  }
  const fileOf = (sb, path, kind) => ({ sandboxId: sb.id, sandbox: sb.name, path, name: path.split("/").pop(), kind, playable: true });

  /** Fige l'image sous la tête de lecture : une photo de 3 s insérée dans le clip. */
  async function freezeFrame() {
    const hit = M.clipAt(P, t);
    if (!hit || hit.clip.kind !== "video") { toast(tt("Placez la tête de lecture sur un clip vidéo.")); return; }
    const el = elFor(hit.clip);
    if (!el.videoWidth) { toast(tt("Image pas encore chargée : réessayez.")); return; }
    const c = document.createElement("canvas");
    c.width = el.videoWidth; c.height = el.videoHeight;
    c.getContext("2d").drawImage(el, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const sb = await targetSandbox();
    if (!sb || !blob) return;
    const path = `Montages/Images figées/image-${stamp()}.png`;
    await writeBlob(sb.id, path, blob);
    const at = t;
    split(at);
    const i = indexAtTime(at + 0.01);
    await add(fileOf(sb, path, "image"), { index: i, dur: 3, silent: true });
    const c2 = P.clips[i];
    if (c2) { c2.motion = "none"; c2.fit = hit.clip.fit; c2.transform = { ...hit.clip.transform }; c2.filter = { ...hit.clip.filter }; save(); renderTimeline(); draw(); }
    ctx.rescan?.();
    toast(tt("Image figée insérée (3 s)."));
  }

  // ---- Voix de synthèse --------------------------------------------------------
  async function ttsVoice(text, at = t) {
    if (!String(text || "").trim()) return null;
    if (!(await ensureSessionUnlocked({ invoke, reason: tt("Créer une voix off") }))) return null;
    let b64 = "";
    try { b64 = await invoke("tts_synth_b64", { text, voice: null }); } catch (e) { toast(`${tt("Voix de synthèse indisponible")} : ${e?.message || e}`); return null; }
    if (!b64) return null;
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const sb = await targetSandbox();
    if (!sb) return null;
    const path = `Montages/Voix off/tts-${stamp()}.wav`;
    await writeBlob(sb.id, path, new Blob([u8], { type: "audio/wav" }));
    ctx.rescan?.();
    return add(fileOf(sb, path, "audio"), { audioKind: "voice", at, silent: true });
  }

  // ---- Voix off au micro ------------------------------------------------------
  let rec = null, recT0 = 0, recTimer = 0;
  async function toggleRecord() {
    if (rec) { rec.stop(); return; }
    if (!(await ensureSessionUnlocked({ invoke, reason: tt("Enregistrer une voix off") }))) return;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { toast(tt("Micro inaccessible : autorisez-le dans les réglages du système.")); return; }
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const chunks = [];
    const at = t;
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop());
      rec = null; clearInterval(recTimer);
      if (master) master.gain.value = 1;
      if (playing) pause();
      updateRecBtn();
      const blob = new Blob(chunks, { type: (mime || "audio/webm").split(";")[0] });
      if (blob.size < 2000) return;
      const sb = await targetSandbox();
      if (!sb) return;
      const path = `Montages/Voix off/voix-${stamp()}.${mime.includes("mp4") ? "m4a" : "webm"}`;
      await writeBlob(sb.id, path, blob);
      ctx.rescan?.();
      await add(fileOf(sb, path, "audio"), { audioKind: "voice", at, silent: true });
      toast(tt("Voix off ajoutée."));
    };
    rec = r; recT0 = Date.now();
    r.start(500);
    // On voit défiler le montage, sans l'entendre (pas d'écho dans le micro).
    audio(); master.gain.value = 0;
    if (M.total(P) > t + 0.1) playFrom(t);
    recTimer = setInterval(updateRecBtn, 250);
    updateRecBtn();
  }
  function updateRecBtn() {
    const b = document.querySelector('[data-tool="record"]');
    if (!b) return;
    b.classList.toggle("rec", !!rec);
    b.innerHTML = rec ? `<span class="rec-pill">${fmtShort((Date.now() - recT0) / 1000)}</span>${esc(tt("Arrêter"))}` : `${ic("mic")}${esc(tt("Voix off"))}`;
    const r2b = document.getElementById("rec-btn-panel");
    if (r2b) r2b.innerHTML = rec ? `${ic("circle-stop")}${esc(tt("Arrêter"))} · ${fmtShort((Date.now() - recT0) / 1000)}` : `${ic("mic")}${esc(tt("Enregistrer depuis la tête de lecture"))}`;
  }

  // ===== Analyse : sous-titres, silences, rythme ============================
  let busyTask = "";
  function status(msg, p = null) {
    const st = document.getElementById("ai-status");
    if (st) st.textContent = msg || "";
    const pr = document.getElementById("ai-progress");
    if (pr) { pr.parentElement.hidden = p == null; pr.style.width = `${Math.round((p || 0) * 100)}%`; }
  }
  async function guard(name, fn) {
    if (busyTask) { toast(tt("Une analyse est déjà en cours.")); return null; }
    if (!(await ensureSessionUnlocked({ invoke, reason: name }))) return null;
    busyTask = name;
    try { return await fn(); }
    catch (e) { toast(`${name} : ${e?.message || e}`); return null; }
    finally { busyTask = ""; status(""); }
  }

  /** Sources sonores parlées du montage (clips vidéo non muets, voix off). */
  function speechSources(onlyId = null) {
    const s = M.clipStarts(P);
    const out = [];
    P.clips.forEach((c, i) => { if (c.kind === "video" && !c.mute && (!onlyId || onlyId === c.id)) out.push({ item: c, tl: s[i] }); });
    for (const o of P.overlays) if (o.kind === "video" && !o.mute && (!onlyId || onlyId === o.id)) out.push({ item: o, tl: o.start });
    for (const m of P.audio) if (m.kind !== "music" && (!onlyId || onlyId === m.id)) out.push({ item: m, tl: m.start });
    return out;
  }

  /** Sous-titres automatiques (Whisper local) → légendes courtes, calées. */
  async function autoCaptions({ preset = "caption", maxWords = 6, onlyId = null } = {}) {
    return guard(tt("Sous-titres automatiques"), async () => {
      const srcs = speechSources(onlyId);
      if (!srcs.length) { toast(tt("Aucune piste parlée à sous-titrer.")); return 0; }
      const { whisperTranscribe } = await import("../lib/whisper-dictation.js");
      const made = [];
      for (let k = 0; k < srcs.length; k++) {
        const { item, tl } = srcs[k];
        status(tt("Lecture de « {n} »…", { n: item.src.name }), 0);
        const buf = await A.decodeAudio(mediaUrl(item.src), (p) => status(tt("Lecture de « {n} »…", { n: item.src.name }), p * 0.2));
        const peaks = A.peaksOf(buf);
        const segs = A.speechSegments(peaks, item.in, Math.min(item.out, buf.duration));
        const sp = item.speed || 1;
        for (let j = 0; j < segs.length; j++) {
          const seg = segs[j];
          status(tt("Transcription {i}/{n}…", { i: j + 1, n: segs.length }), 0.2 + (0.8 * j) / segs.length);
          const pcm = await A.pcm16k(buf, seg.start, seg.end);
          let text = "";
          try { text = await whisperTranscribe(pcm, (p) => { if (p?.status === "progress" && p.progress) status(tt("Téléchargement du modèle Whisper… {p} %", { p: Math.round(p.progress) })); }); } catch (e) { throw new Error(tt("Whisper indisponible : {e}", { e: e?.message || e })); }
          text = String(text || "").trim();
          if (!text) continue;
          // Légendes courtes façon réseaux sociaux : ≤ maxWords mots, temps
          // réparti au prorata des caractères.
          const words = text.split(/\s+/);
          const groups = [];
          for (let w = 0; w < words.length; w += maxWords) groups.push(words.slice(w, w + maxWords).join(" "));
          const total = groups.reduce((a, g) => a + g.length, 0) || 1;
          let cur = tl + (seg.start - item.in) / sp;
          const segLen = (seg.end - seg.start) / sp;
          for (const gtx of groups) {
            const d = (segLen * gtx.length) / total;
            made.push({ text: gtx, start: r2(cur), end: r2(cur + Math.max(0.4, d)) });
            cur += d;
          }
        }
      }
      if (!made.length) { toast(tt("Aucune parole détectée.")); return 0; }
      const ps = TEXT_PRESETS.find((p) => p.id === preset) || TEXT_PRESETS.find((p) => p.id === "caption");
      change(() => {
        const lane = Math.max(-1, ...P.texts.map((x) => x.lane)) + 1;
        for (const m of made) P.texts.push(M.newText({ ...structuredClone(ps.s), kind: "caption", preset: ps.id, text: m.text, start: m.start, end: m.end, lane }));
      });
      toast(tt("{n} sous-titres ajoutés.", { n: made.length }));
      return made.length;
    });
  }

  /** Coupe les silences des clips vidéo (tous, ou celui indiqué). */
  async function removeSilences({ onlyId = null, minDur = 0.6 } = {}) {
    return guard(tt("Couper les silences"), async () => {
      const targets = P.clips.filter((c) => c.kind === "video" && (!onlyId || c.id === onlyId));
      if (!targets.length) { toast(tt("Aucun clip vidéo à traiter.")); return 0; }
      const plan = new Map();
      let saved = 0;
      for (let k = 0; k < targets.length; k++) {
        const c = targets[k];
        status(tt("Analyse de « {n} »…", { n: c.src.name }), k / targets.length);
        let buf;
        try { buf = await A.decodeAudio(mediaUrl(c.src)); } catch { continue; }
        const sil = A.detectSilences(A.peaksOf(buf), c.in, Math.min(c.out, buf.duration), { minDur });
        if (!sil.length) continue;
        const keep = [];
        let cur = c.in;
        for (const s of sil) { if (s.start - cur > 0.15) keep.push([cur, s.start]); cur = s.end; }
        if (c.out - cur > 0.15) keep.push([cur, c.out]);
        saved += sil.reduce((a, s) => a + (s.end - s.start), 0) / (c.speed || 1);
        plan.set(c.id, keep);
      }
      if (!plan.size) { toast(tt("Aucun silence assez long trouvé.")); return 0; }
      change(() => {
        const out = [];
        for (const c of P.clips) {
          const keep = plan.get(c.id);
          if (!keep) { out.push(c); continue; }
          keep.forEach(([a, b], j) => out.push({ ...structuredClone(c), id: j === 0 ? c.id : M.uid(), in: a, out: b, fadeIn: j === 0 ? c.fadeIn : 0, fadeOut: j === keep.length - 1 ? c.fadeOut : 0, transition: j === keep.length - 1 ? c.transition : null }));
        }
        P.clips = out;
      });
      toast(tt("Silences coupés : {s} s gagnées.", { s: Math.round(saved * 10) / 10 }));
      return r2(saved);
    });
  }

  /** Repères sur les temps forts de la musique, et coupes des photos calées dessus. */
  async function beatSync({ musicId = null, cutImages = true } = {}) {
    return guard(tt("Caler sur le rythme"), async () => {
      const m = P.audio.find((a) => a.id === musicId) || P.audio.find((a) => a.id === sel?.id && a.kind === "music") || P.audio.find((a) => a.kind === "music");
      if (!m) { toast(tt("Ajoutez d'abord une musique.")); return null; }
      status(tt("Analyse du rythme…"), 0.3);
      const buf = await A.decodeAudio(mediaUrl(m.src));
      const { beats, bpm, interval } = A.detectBeats(buf, { from: m.in, to: Math.min(m.out, buf.duration) });
      const sp = m.speed || 1;
      const tlBeats = beats.map((b) => m.start + (b - m.in) / sp).filter((x) => x >= 0);
      change(() => {
        P.markers = [...new Set([...P.markers.filter((x) => !tlBeats.some((b) => Math.abs(b - x) < 0.05)), ...tlBeats.map(r2)])].sort((a, b) => a - b);
        if (!cutImages) return;
        // Chaque photo se termine sur un temps fort : au moins ~1,5 s à l'écran,
        // en sautant les temps trop rapprochés (tempo rapide).
        const step = interval * Math.max(1, Math.round(1.5 / interval));
        let acc = 0;
        P.clips.forEach((c, i) => {
          const len = M.clipLen(c) - M.transDur(P, i);
          if (c.kind === "image" || c.kind === "color") {
            const target = tlBeats.find((b) => b >= acc + step * 0.8) ?? acc + step;
            c.dur = r2(Math.max(0.5, target - acc + M.transDur(P, i)));
            acc = target;
          } else acc += len;
        });
      });
      toast(tt("{n} temps forts repérés (≈ {b} BPM).", { n: tlBeats.length, b: bpm }));
      return { bpm, beats: tlBeats.length };
    });
  }

  /** Montage automatique : transitions, filtre, mouvements, titre, musique calée. */
  async function autoMontage({ files = [], style = "dynamic", music = null, title = "", duration = 0, aspect = "" } = {}) {
    for (const f of files) await add(f, { silent: true });
    if (music) await add(music, { track: "audio", audioKind: "music", at: 0, silent: true });
    if (!P.clips.length) { toast(tt("Ajoutez d'abord des médias à la timeline.")); return null; }
    const STY = {
      dynamic: { trans: ["slideleft", "zoom", "wipe", "slideup"], dur: 0.35, img: 2, filter: "vivid", title: "title" },
      calm: { trans: ["fade"], dur: 0.9, img: 4.5, filter: "warm", title: "quote" },
      cinematic: { trans: ["black", "fade"], dur: 0.8, img: 4, filter: "cinema", title: "title" },
      vlog: { trans: ["fade", "slideleft"], dur: 0.4, img: 3, filter: "vivid", title: "highlight" },
    }[style] || {};
    change(() => {
      if (aspect && M.ASPECTS[aspect]) P.aspect = aspect;
      if (title) P.title = title;
      const imgs = P.clips.filter((c) => c.kind === "image").length;
      const vidLen = P.clips.filter((c) => c.kind === "video").reduce((a, c) => a + M.clipLen(c), 0);
      const perImg = duration && imgs ? clamp((duration - vidLen) / imgs, 1, 10) : STY.img;
      P.clips.forEach((c, i) => {
        if (c.kind === "image") { c.dur = r2(perImg); c.motion = i % 2 ? "out" : "in"; }
        c.filter = filterFromPreset(STY.filter);
        c.transition = i < P.clips.length - 1 ? { type: STY.trans[i % STY.trans.length], dur: STY.dur } : null;
      });
      const T = M.total(P);
      if (P.title && !P.texts.some((x) => x.preset === STY.title && x.start < 0.5)) {
        const ps = TEXT_PRESETS.find((p) => p.id === STY.title);
        P.texts.push(M.newText({ ...structuredClone(ps.s), preset: ps.id, text: P.title, start: 0, end: Math.min(3, T), lane: 0 }));
      }
      for (const m of P.audio) if (m.kind === "music") { m.fadeIn = 0.5; m.fadeOut = 2.5; m.out = Math.min(m.out, m.in + T * (m.speed || 1)); }
    });
    resize();
    if (P.audio.some((m) => m.kind === "music") && P.clips.some((c) => c.kind === "image")) await beatSync({ cutImages: true });
    return M.describe(P);
  }

  // ===== Timeline ============================================================
  const thumbs = new Map();  // source → data: URL (bande de vignettes) | "pending"
  const waves = new Map();   // source → peaks | null | "pending"

  function lanesOf(items) { return Math.max(1, ...items.map((x) => (x.lane | 0) + 1)); }
  function tickStep() {
    for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) if (s * pps >= 64) return s;
    return 600;
  }

  function block(cls, item, left, width, inner) {
    return `<div class="blk ${cls}${sel?.id === item.id ? " is-sel" : ""}" data-id="${item.id}" style="left:${left}px;width:${Math.max(4, width)}px">${inner}<i class="h h-l" data-edge="l"></i><i class="h h-r" data-edge="r"></i></div>`;
  }
  function waveSvg(item, w, h) {
    const k = keyOf(item.src);
    const pk = waves.get(k);
    if (!pk || pk === "pending") return "";
    const d = A.waveformPath(pk, item.in, item.out, w, h);
    return d ? `<svg class="wave" viewBox="0 0 ${Math.max(1, Math.round(w))} ${h}" preserveAspectRatio="none"><path d="${d}"/></svg>` : "";
  }
  function row(cls, label, inner, attrs = "") {
    return `<div class="tl-row ${cls}" ${attrs}><div class="tl-label">${label}</div><div class="tl-lane">${inner}</div></div>`;
  }

  function renderTimeline() {
    const T = M.total(P);
    const span = Math.max(T, 10) + 20;
    const width = LABEL + span * pps;
    const s = M.clipStarts(P);
    const step = tickStep();
    let ticks = "";
    for (let x = 0; x <= span; x += step) ticks += `<span class="tick" style="left:${x * pps}px">${fmtShort(x)}</span>`;
    for (let x = step / 2; x <= span; x += step) ticks += `<span class="tick minor" style="left:${x * pps}px"></span>`;
    const marks = P.markers.map((m) => `<span class="marker" data-t="${m}" style="left:${m * pps}px" title="${esc(fmt(m))}"></span>`).join("");
    let html = row("ruler", "", ticks + marks);

    // Textes (la piste la plus haute en haut), puis incrustations.
    const nT = lanesOf(P.texts) + (dragCat === "text" ? 1 : 0);
    for (let l = nT - 1; l >= 0; l--) {
      const inner = P.texts.filter((x) => (x.lane | 0) === l).map((x) =>
        block(`blk-${x.kind === "caption" ? "caption" : x.kind === "sticker" ? "sticker" : "text"}`, x, x.start * pps, (x.end - x.start) * pps, `<span class="nm">${esc(x.text.replace(/\n/g, " ") || "…")}</span>`)).join("");
      html += row(`text${l >= lanesOf(P.texts) ? " drop" : ""}`, `${ic("type")}${esc(tt("Texte"))}${l === 0 ? ` <button data-add="text" title="${esc(tt("Ajouter un texte"))}">${ic("plus")}</button>` : ""}`, inner, `data-cat="text" data-lane="${l}"`);
    }
    const nO = lanesOf(P.overlays) + (dragCat === "overlay" ? 1 : 0);
    for (let l = nO - 1; l >= 0; l--) {
      const inner = P.overlays.filter((o) => (o.lane | 0) === l).map((o) =>
        block(`blk-overlay blk-${o.kind}`, o, o.start * pps, M.clipLen(o) * pps, `<span class="nm">${esc(o.src?.name || "")}</span>${o.speed !== 1 ? `<span class="badge">×${o.speed}</span>` : ""}`)).join("");
      html += row(`overlay${l >= lanesOf(P.overlays) ? " drop" : ""}`, `${ic("layers")}${esc(tt("Incrust."))}`, inner, `data-cat="overlay" data-lane="${l}"`);
    }

    // Piste principale + boutons de transition aux jonctions.
    let main = P.clips.map((c, i) => {
      const name = c.kind === "color" ? tt("Couleur") : c.src?.name || "";
      const badges = `${c.speed !== 1 ? `<span class="badge">×${c.speed}</span>` : ""}${c.filter?.preset && c.filter.preset !== "none" ? `<span class="badge">${ic("palette")}</span>` : ""}${c.mute ? `<span class="badge">${ic("volume-x")}</span>` : ""}`;
      return block(`blk-${c.kind}`, c, s[i] * pps, M.clipLen(c) * pps, `<span class="nm">${esc(name)}</span>${badges}`);
    }).join("");
    for (let i = 0; i < P.clips.length - 1; i++) {
      const d = M.transDur(P, i);
      const x = (s[i] + M.clipLen(P.clips[i]) - d / 2) * pps;
      const has = !!P.clips[i].transition;
      main += `<button class="tr-btn${has ? " has" : ""}${sel?.type === "transition" && sel.id === P.clips[i].id ? " is-sel" : ""}" data-tr="${P.clips[i].id}" style="left:${x}px" title="${esc(tt("Transition"))}">${ic("blend")}</button>`;
    }
    if (!P.clips.length) main += `<span class="tl-empty">${esc(tt("Glissez des vidéos ou des photos ici, ou cliquez-les dans le panneau Médias."))}</span>`;
    html += row("main", `${ic("film")}${esc(tt("Principal"))}`, main, `data-cat="main" data-lane="0"`);

    const nA = lanesOf(P.audio) + (dragCat === "audio" ? 1 : 0);
    for (let l = 0; l < nA; l++) {
      const inner = P.audio.filter((m) => (m.lane | 0) === l).map((m) => {
        const w = M.audioLen(m) * pps;
        return block(`blk-${m.kind}`, m, m.start * pps, w, `<span class="nm">${esc(m.src?.name || "")}</span>${m.speed !== 1 ? `<span class="badge">×${m.speed}</span>` : ""}${waveSvg(m, w, 26)}`);
      }).join("");
      html += row(`audio${l >= lanesOf(P.audio) ? " drop" : ""}`, `${ic("music")}${esc(tt("Audio"))}`, inner, `data-cat="audio" data-lane="${l}"`);
    }
    html += `<div class="playhead" id="playhead"></div>`;
    const content = $("tl-content");
    content.style.width = `${width}px`;
    content.innerHTML = html;
    placePlayhead();
    paintThumbs();
    loadWaves();
  }

  function placePlayhead() {
    const ph = document.getElementById("playhead");
    if (ph) ph.style.left = `${LABEL + t * pps}px`;
  }

  function paintThumbs() {
    for (const node of document.querySelectorAll("#tl-content .blk-video, #tl-content .blk-image")) {
      const f = M.findItem(P, node.dataset.id);
      const it = f?.item;
      if (!it?.src) continue;
      const k = keyOf(it.src);
      if (it.kind === "image") {
        const im = imgs.get(k);
        if (im?.src && im.complete) node.style.backgroundImage = `url("${im.src}")`;
        else imgFor(it.src);
        continue;
      }
      const v = thumbs.get(k);
      if (v && v !== "pending") node.style.backgroundImage = `url("${v}")`;
      else if (!v && it.srcDur) {
        thumbs.set(k, "pending");
        A.filmstrip(mediaUrl(it.src), it.srcDur, 10, 52).then((url) => { thumbs.set(k, url || ""); paintThumbs(); });
      }
    }
  }
  function loadWaves() {
    for (const m of P.audio) {
      const k = keyOf(m.src);
      if (waves.has(k)) continue;
      waves.set(k, "pending");
      A.peaksForUrl(mediaUrl(m.src)).then((pk) => { waves.set(k, pk); if (!dragState) renderTimeline(); });
    }
  }

  // ---- Aimantation -------------------------------------------------------------
  function snapTime(time, excludeId) {
    if (!snapOn) return { time, hit: false };
    const tol = 8 / pps;
    const cands = [0, t, ...P.markers];
    const s = M.clipStarts(P);
    P.clips.forEach((c, i) => { if (c.id !== excludeId) cands.push(s[i], s[i] + M.clipLen(c)); });
    for (const o of P.overlays) if (o.id !== excludeId) cands.push(o.start, o.start + M.clipLen(o));
    for (const x of P.texts) if (x.id !== excludeId) cands.push(x.start, x.end);
    for (const m of P.audio) if (m.id !== excludeId) cands.push(m.start, m.start + M.audioLen(m));
    let best = null, bd = tol;
    for (const c of cands) { const d = Math.abs(c - time); if (d < bd) { bd = d; best = c; } }
    return best == null ? { time, hit: false } : { time: best, hit: true };
  }
  function showSnap(time) {
    let ln = document.getElementById("snap-line");
    if (time == null) { ln?.remove(); return; }
    if (!ln) { ln = document.createElement("div"); ln.id = "snap-line"; ln.className = "snap-line"; $("tl-content").appendChild(ln); }
    ln.style.left = `${LABEL + time * pps}px`;
  }

  // ---- Interactions ------------------------------------------------------------
  let dragState = null;
  function wireTimeline() {
    const tl = $("timeline");
    const timeAt = (ev) => (ev.clientX - $("tl-content").getBoundingClientRect().left - LABEL) / pps;
    tl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const addBtn = e.target.closest("[data-add]");
      if (addBtn) { addText(); return; }
      if (e.target.closest(".tl-label")) return;
      const tr = e.target.closest(".tr-btn");
      if (tr) { select({ type: "transition", id: tr.dataset.tr }); return; }
      const mk = e.target.closest(".marker");
      if (mk) { pause(); seek(Number(mk.dataset.t)); return; }
      const blk = e.target.closest(".blk");
      if (!blk) {
        pause();
        seek(timeAt(e));
        if (!e.target.closest(".ruler") && !e.target.closest(".playhead")) select(null);
        dragState = { scrub: true };
        tl.setPointerCapture(e.pointerId);
        return;
      }
      const f = M.findItem(P, blk.dataset.id);
      if (!f) return;
      if (sel?.id !== f.item.id) select({ type: f.type, id: f.item.id });
      dragState = { f, edge: e.target.dataset.edge || "", x0: e.clientX, y0: e.clientY, snap: structuredClone(f.item), moved: false, pushed: false, span: M.spanOf(P, f.item.id) };
      tl.setPointerCapture(e.pointerId);
    });
    tl.addEventListener("pointermove", (e) => {
      const d = dragState;
      if (!d) return;
      if (d.scrub) { seek(timeAt(e)); return; }
      const px = e.clientX - d.x0;
      if (!d.moved && Math.abs(px) < 3 && Math.abs(e.clientY - d.y0) < 4) return;
      if (!d.moved) { d.moved = true; if (!d.pushed) { hist.push(P); d.pushed = true; } if (d.f.type !== "clip" && !d.edge) { dragCat = d.f.type; } }
      const dt = px / pps;
      const { f, snap, edge } = d;
      const it = f.item;
      const sp = it.speed || 1;
      let snapAt = null;
      const maxOut = it.srcDur || (it.kind === "video" ? els.get(it.id)?.duration : 0) || snap.out;
      if (f.type === "clip") {
        if (edge === "l") {
          if (it.kind === "video") it.in = clamp(snap.in + dt * sp, 0, snap.out - 0.1);
          else it.dur = Math.max(0.2, snap.dur - dt);
        } else if (edge === "r") {
          const end = snapTime(d.span.end + dt, it.id);
          if (end.hit) snapAt = end.time;
          const ndt = end.time - d.span.end;
          if (it.kind === "video") it.out = clamp(snap.out + ndt * sp, snap.in + 0.1, Number.isFinite(maxOut) ? maxOut : snap.out + 1e6);
          else it.dur = Math.max(0.2, snap.dur + ndt);
        } else {
          // Réordonner : le clip se pose là où pointe la souris.
          const at = timeAt(e);
          const others = P.clips.filter((c) => c !== it);
          const s = [];
          let acc = 0;
          for (const c of others) { s.push(acc); acc += M.clipLen(c); }
          let ni = 0;
          while (ni < others.length && s[ni] + M.clipLen(others[ni]) / 2 < at) ni++;
          const ci = P.clips.indexOf(it);
          if (ni !== ci) { P.clips.splice(ci, 1); P.clips.splice(ni, 0, it); }
        }
      } else {
        const len = d.span.end - d.span.start;
        if (!edge) {
          let ns = Math.max(0, snap.start + dt);
          const a = snapTime(ns, it.id), b = snapTime(ns + len, it.id);
          if (a.hit) { ns = a.time; snapAt = a.time; } else if (b.hit) { ns = Math.max(0, b.time - len); snapAt = b.time; }
          it.start = ns;
          if (f.type === "text") it.end = ns + len;
          // Changement de piste : la ligne de même catégorie sous le pointeur.
          const rowEl = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".tl-row");
          if (rowEl?.dataset.cat === f.type) it.lane = Number(rowEl.dataset.lane) || 0;
        } else if (edge === "l") {
          const a = snapTime(snap.start + dt, it.id);
          if (a.hit) snapAt = a.time;
          if (f.type === "text") it.start = clamp(a.time, 0, snap.end - 0.2);
          else {
            const minStart = it.kind === "image" ? -1e9 : snap.start - snap.in / sp;
            const ns = clamp(a.time, Math.max(0, minStart), d.span.end - 0.1);
            if (it.kind === "image") it.dur = Math.max(0.2, snap.dur - (ns - snap.start));
            else it.in = snap.in + (ns - snap.start) * sp;
            it.start = ns;
          }
        } else {
          const b = snapTime(d.span.end + dt, it.id);
          if (b.hit) snapAt = b.time;
          const ndt = b.time - d.span.end;
          if (f.type === "text") it.end = Math.max(snap.start + 0.2, snap.end + ndt);
          else if (it.kind === "image") it.dur = Math.max(0.2, snap.dur + ndt);
          else it.out = clamp(snap.out + ndt * sp, snap.in + 0.1, Number.isFinite(maxOut) && maxOut > 0 ? maxOut : snap.out + 1e6);
        }
      }
      renderTimeline();
      showSnap(snapAt);
      draw();
    });
    const end = () => {
      const d = dragState;
      dragState = null;
      showSnap(null);
      if (!d || d.scrub) return;
      const wasCat = dragCat;
      dragCat = "";
      if (d.moved) after();
      else if (wasCat) renderTimeline();
    };
    tl.addEventListener("pointerup", end);
    tl.addEventListener("pointercancel", end);
    tl.addEventListener("wheel", (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setZoom(pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e);
    }, { passive: false });
    tl.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/lumen-media")) e.preventDefault(); });
    tl.addEventListener("drop", (e) => {
      const i = e.dataTransfer.getData("text/lumen-media");
      if (i === "") return;
      e.preventDefault();
      const f = ctx.files()[Number(i)];
      if (!f) return;
      const at = Math.max(0, timeAt(e));
      const rowEl = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".tl-row");
      const cat = rowEl?.dataset.cat || "main";
      if (f.kind === "audio") add(f, { track: "audio", at, lane: cat === "audio" ? Number(rowEl.dataset.lane) : undefined });
      else if (cat === "overlay" || cat === "text") add(f, { track: "overlay", at, lane: cat === "overlay" ? Number(rowEl.dataset.lane) : undefined });
      else add(f, { at });
    });
  }

  function setZoom(v, ev = null) {
    const tl = $("timeline");
    const anchorT = ev ? (ev.clientX - $("tl-content").getBoundingClientRect().left - LABEL) / pps : t;
    const screenX = LABEL + anchorT * pps - tl.scrollLeft;
    pps = clamp(v, 8, 300);
    store.set("pps", String(Math.round(pps)));
    $("tl-zoom").value = String(Math.round(pps));
    renderTimeline();
    tl.scrollLeft = Math.max(0, LABEL + anchorT * pps - screenX);
  }
  function fitZoom() {
    const tl = $("timeline");
    setZoom((tl.clientWidth - LABEL - 40) / Math.max(5, M.total(P)));
    tl.scrollLeft = 0;
  }

  // ===== Aperçu interactif (sélection, déplacement, taille, rotation) =======
  function drawSel() {
    const layer = $("sel-layer");
    if (!layer) return;
    if (!sel || playing || exporting || sel.type === "transition" || sel.type === "audio") { layer.innerHTML = ""; return; }
    const b = boxes.find((x) => x.id === sel.id);
    if (!b) { layer.innerHTML = ""; return; }
    const k = canvas.clientWidth / canvas.width;
    const rot = sel.type !== "clip";
    layer.innerHTML = `<div class="sel-box" style="left:${b.x * k}px;top:${b.y * k}px;width:${b.w * k}px;height:${b.h * k}px"><i data-h="scale"></i>${rot ? '<b data-h="rotate"></b>' : ""}</div>`;
  }
  function wireCanvas() {
    const box = $("canvas-box");
    let d = null;
    const toCanvas = (e) => { const r = canvas.getBoundingClientRect(); const k = canvas.width / r.width; return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }; };
    box.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || exporting) return;
      const p = toCanvas(e);
      const handle = e.target.dataset?.h || "";
      let target = null;
      if (handle && sel) target = M.findItem(P, sel.id);
      else {
        for (let i = boxes.length - 1; i >= 0; i--) {
          const b = boxes[i];
          if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) { target = M.findItem(P, b.id); break; }
        }
      }
      if (!target) { select(null); return; }
      if (playing) pause();
      if (sel?.id !== target.item.id) select({ type: target.type, id: target.item.id });
      const b = boxes.find((x) => x.id === target.item.id) || { x: p.x, y: p.y, w: 1, h: 1 };
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      d = { f: target, handle, p0: p, snap: structuredClone(target.item), pushed: false, cx, cy, r0: Math.hypot(p.x - cx, p.y - cy) || 1, a0: Math.atan2(p.y - cy, p.x - cx) };
      box.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    box.addEventListener("pointermove", (e) => {
      if (!d) return;
      const p = toCanvas(e);
      if (!d.pushed) { if (Math.hypot(p.x - d.p0.x, p.y - d.p0.y) < 2) return; hist.push(P); d.pushed = true; }
      const it = d.f.item, s = d.snap;
      const W = canvas.width, H = canvas.height;
      if (d.handle === "scale") {
        const ratio = Math.hypot(p.x - d.cx, p.y - d.cy) / d.r0;
        if (d.f.type === "text") it.size = clamp(Math.round(s.size * ratio), 12, 600);
        else it.transform.scale = clamp(r2(s.transform.scale * ratio), 0.05, 6);
      } else if (d.handle === "rotate") {
        let a = ((Math.atan2(p.y - d.cy, p.x - d.cx) - d.a0) * 180) / Math.PI;
        let base = d.f.type === "text" ? (s.rotate || 0) : s.transform.rotate;
        let v = Math.round(base + a);
        for (const snapA of [0, 90, -90, 180, -180]) if (Math.abs(v - snapA) < 4) v = snapA;
        if (d.f.type === "text") it.rotate = v; else it.transform.rotate = v;
      } else if (d.f.type === "text") {
        let nx = clamp(s.x + (p.x - d.p0.x) / W, 0, 1), ny = clamp(s.y + (p.y - d.p0.y) / H, 0, 1);
        if (Math.abs(nx - 0.5) < 0.012) nx = 0.5;
        if (Math.abs(ny - 0.5) < 0.012) ny = 0.5;
        it.x = r2(nx * 100) / 100; it.y = r2(ny * 100) / 100;
      } else {
        let nx = s.transform.x + (p.x - d.p0.x) / W, ny = s.transform.y + (p.y - d.p0.y) / H;
        if (Math.abs(nx) < 0.012) nx = 0;
        if (Math.abs(ny) < 0.012) ny = 0;
        it.transform.x = Math.round(nx * 1000) / 1000; it.transform.y = Math.round(ny * 1000) / 1000;
      }
      draw();
    });
    const up = () => { if (d?.pushed) { save(); renderInspector(); updateUndo(); } d = null; };
    box.addEventListener("pointerup", up);
    box.addEventListener("pointercancel", up);
    box.addEventListener("dblclick", () => {
      if (sel?.type !== "text") return;
      inspTab = "text"; renderInspector();
      setTimeout(() => document.querySelector('#inspector textarea[data-k="text"]')?.select(), 30);
    });
  }

  // ===== Sélection et inspecteur =============================================
  function select(s) {
    sel = s;
    if (s?.type === "text") { if (!["text", "style", "anim"].includes(inspTab)) inspTab = "text"; }
    else if (s?.type === "clip" || s?.type === "overlay") { if (!["general", "frame", "color"].includes(inspTab)) inspTab = "general"; }
    renderTimeline(); renderInspector(); drawSel();
  }

    const setPath = (o, k, v) => { const ps = k.split("."); const last = ps.pop(); const tg = ps.reduce((a, p) => (a[p] ??= {}), o); tg[last] = v; };

  // Contrôles : `data-k` = chemin dans l'élément, `data-u` = unité d'affichage.
  function slider(label, k, v, min, max, step, unit = "", scale = 1) {
    const shown = unit === "%" ? `${Math.round(v * scale)} %` : unit === "°" ? `${Math.round(v)}°` : unit === "s" ? `${r2(v)} s` : unit === "×" ? `×${r2(v)}` : `${r2(v * scale)}`;
    return `<label class="f"><span>${esc(tt(label))}<em data-show="${k}">${shown}</em></span><input class="range" type="range" data-k="${k}" data-scale="${scale}" data-unit="${unit}" min="${min}" max="${max}" step="${step}" value="${v * scale}" /></label>`;
  }
  function numF(label, k, v, step = 0.1, min = 0, max = 99999) {
    return `<label class="f"><span>${esc(tt(label))}</span><input class="input" type="number" data-k="${k}" value="${r2(v)}" step="${step}" min="${min}" max="${max}" /></label>`;
  }
  function selectF(label, k, v, opts) {
    return `<label class="f"><span>${esc(tt(label))}</span><select class="select" data-k="${k}">${opts.map((o) => `<option value="${esc(o.id)}"${String(v) === String(o.id) ? " selected" : ""}>${esc(tt(o.label))}</option>`).join("")}</select></label>`;
  }
  function checkF(label, k, v) { return `<label class="chk"><input type="checkbox" data-k="${k}"${v ? " checked" : ""} /> ${esc(tt(label))}</label>`; }
  function colorF(label, k, v, swatches) {
    return `<div class="f"><span>${esc(tt(label))}</span><div class="color-row">${swatches.map((c) => `<button class="swatch${v === c ? " is-on" : ""}" data-set="${k}" data-val="${esc(c)}" style="background:${c === "transparent" ? "repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 50%/8px 8px" : c}" title="${esc(c)}"></button>`).join("")}<input type="color" data-k="${k}" value="${/^#[0-9a-f]{6}$/i.test(v) ? v : "#ffffff"}" /></div></div>`;
  }
  const tabs = (list) => `<div class="insp-tabs">${list.map(([id, label]) => `<button class="insp-tab${inspTab === id ? " is-on" : ""}" data-tab-i="${id}">${esc(tt(label))}</button>`).join("")}</div>`;
  const head = (title, actions = "") => `<div class="insp-head"><h3>${esc(title)}</h3>${actions}</div>`;

  function renderInspector() {
    const box = $("inspector");
    let html = "";
    let item = null;
    if (!sel) html = projectPanel();
    else if (sel.type === "transition") {
      item = P.clips.find((c) => c.id === sel.id);
      if (!item) { sel = null; return renderInspector(); }
      const tr = item.transition || { type: "none", dur: 0.5 };
      html = head(tt("Transition")) + `<div class="insp-body"><div class="tile-grid three">${TRANSITIONS.map((x) => `<button class="tile${tr.type === x.id ? " is-on" : ""}" data-act="transition" data-val="${x.id}"><div class="tile-art photo" style="height:34px">${ic("blend")}</div><small>${esc(tt(x.label))}</small></button>`).join("")}</div>`
        + (item.transition ? slider("Durée", "transition.dur", tr.dur, 0.1, 3, 0.05, "s") : "")
        + `<button class="btn outline sm" data-act="transition-all">${esc(tt("Appliquer à toutes les jonctions"))}</button></div>`;
    } else {
      const f = M.findItem(P, sel.id);
      if (!f) { sel = null; return renderInspector(); }
      item = f.item;
      if (f.type === "text") html = textPanel(item);
      else if (f.type === "audio") html = audioPanel(item);
      else html = visualPanel(item, f.type);
    }
    box.innerHTML = html;
    bindInspector(item);
  }

  function projectPanel() {
    const T = M.total(P);
    return head(tt("Projet")) + `<div class="insp-body">
      <div class="sect"><div class="sect-title">${esc(tt("Format"))}</div>
        ${selectF("Format", "P.aspect", P.aspect, Object.keys(M.ASPECTS).map((k) => ({ id: k, label: ASPECT_LABELS[k] })))}
        <div class="grid2">${selectF("Qualité", "P.quality", P.quality, [480, 720, 1080, 1440, 2160].map((q) => ({ id: q, label: `${q}p` })))}${selectF("Images/s", "P.fps", P.fps, [24, 25, 30, 60].map((q) => ({ id: q, label: String(q) })))}</div>
      </div>
      <div class="sect"><div class="sect-title">${esc(tt("Arrière-plan"))}</div>
        ${selectF("Remplissage des bords", "P.bg.mode", P.bg.mode, [{ id: "black", label: "Noir" }, { id: "color", label: "Couleur" }, { id: "blur", label: "Flou de l'image" }])}
        ${P.bg.mode === "color" ? colorF("Couleur", "P.bg.color", P.bg.color, ["#000000", "#ffffff", "#101014", "#1e3a8a", "#7c2d12", "#14532d", "#ff375f", "#ffd60a"]) : ""}
      </div>
      <div class="sect"><div class="sect-title">${esc(tt("Résumé"))}</div>
        <div class="stat"><span>${esc(tt("Durée"))}</span><b>${fmt(T)}</b></div>
        <div class="stat"><span>${esc(tt("Clips"))}</span><b>${P.clips.length}</b></div>
        <div class="stat"><span>${esc(tt("Incrustations"))}</span><b>${P.overlays.length}</b></div>
        <div class="stat"><span>${esc(tt("Textes"))}</span><b>${P.texts.length}</b></div>
        <div class="stat"><span>${esc(tt("Pistes audio"))}</span><b>${P.audio.length}</b></div>
        <div class="stat"><span>${esc(tt("Repères"))}</span><b>${P.markers.length}</b></div>
      </div>
      <div class="sect"><div class="sect-title">${esc(tt("Raccourcis"))}</div>
        <div class="muted small" style="line-height:1.9">
          <span class="kbd">Espace</span> ${esc(tt("lecture"))} · <span class="kbd">S</span> ${esc(tt("couper"))} · <span class="kbd">Suppr</span> ${esc(tt("supprimer"))}<br>
          <span class="kbd">⌘Z</span> ${esc(tt("annuler"))} · <span class="kbd">⌘D</span> ${esc(tt("dupliquer"))} · <span class="kbd">M</span> ${esc(tt("repère"))}<br>
          <span class="kbd">←</span><span class="kbd">→</span> ${esc(tt("image par image"))} · <span class="kbd">⌘J</span> ${esc(tt("assistant"))}
        </div>
      </div>
      ${P.markers.length ? `<button class="btn outline sm" data-act="clear-markers">${esc(tt("Effacer les repères"))}</button>` : ""}
    </div>`;
  }

  function visualPanel(it, type) {
    const name = it.kind === "color" ? tt("Fond de couleur") : it.src?.name || "";
    if (!["general", "frame", "color"].includes(inspTab)) inspTab = "general";
    let body = "";
    if (inspTab === "general") {
      if (it.kind === "video") {
        body += `<div class="sect"><div class="sect-title">${esc(tt("Découpe"))}</div><div class="grid2">${numF("Début (s)", "in", it.in)}${numF("Fin (s)", "out", it.out)}</div></div>`;
        body += `<div class="sect"><div class="sect-title">${esc(tt("Vitesse"))}</div>${slider("Vitesse", "speed", it.speed, 0.25, 4, 0.05, "×")}<div class="row">${[0.5, 1, 1.5, 2, 3].map((v) => `<button class="btn ${it.speed === v ? "primary" : "outline"} xs" data-set="speed" data-val="${v}">×${v}</button>`).join("")}</div></div>`;
        body += `<div class="sect"><div class="sect-title">${esc(tt("Son"))}</div>${slider("Volume", "volume", it.volume ?? 1, 0, 200, 1, "%", 100)}${checkF("Couper le son", "mute", it.mute)}</div>`;
      } else {
        body += `<div class="sect"><div class="sect-title">${esc(tt("Durée"))}</div>${numF("Durée (s)", "dur", it.dur, 0.1, 0.2, 600)}</div>`;
        if (it.kind === "color") body += colorF("Couleur", "color", it.color, ["#000000", "#ffffff", "#111827", "#1e3a8a", "#7c2d12", "#14532d", "#ff375f", "#ffd60a", "#5e5ce6"]);
      }
      body += `<div class="sect"><div class="sect-title">${esc(tt("Fondus"))}</div>${slider("Fondu d'entrée", "fadeIn", it.fadeIn || 0, 0, 3, 0.1, "s")}${slider("Fondu de sortie", "fadeOut", it.fadeOut || 0, 0, 3, 0.1, "s")}</div>`;
      if (type === "overlay") body += `<div class="sect"><div class="sect-title">${esc(tt("Position dans le temps"))}</div>${numF("Début (s)", "start", it.start)}</div>`;
    } else if (inspTab === "frame") {
      if (type === "clip" && it.kind !== "color") body += `<div class="sect">${selectF("Cadrage", "fit", it.fit, [{ id: "cover", label: "Remplir (recadrer)" }, { id: "contain", label: "Entier (bords visibles)" }])}</div>`;
      body += `<div class="sect"><div class="sect-title">${esc(tt("Transformation"))}</div>
        ${slider("Échelle", "transform.scale", it.transform.scale, 5, 400, 1, "%", 100)}
        ${slider("Position X", "transform.x", it.transform.x, -100, 100, 1, "%", 100)}
        ${slider("Position Y", "transform.y", it.transform.y, -100, 100, 1, "%", 100)}
        ${slider("Rotation", "transform.rotate", it.transform.rotate, -180, 180, 1, "°")}
        ${slider("Opacité", "transform.opacity", it.transform.opacity, 0, 100, 1, "%", 100)}
        <div class="row"><button class="btn outline xs" data-act="flipH">${ic("flip-horizontal")}${esc(tt("Miroir"))}</button><button class="btn outline xs" data-act="flipV">${ic("flip-vertical")}${esc(tt("Retourner"))}</button><button class="btn ghost xs" data-act="reset-tf">${esc(tt("Réinitialiser"))}</button></div></div>`;
      body += `<div class="sect">${selectF("Mouvement", "motion", it.motion, MOTIONS)}</div>`;
    } else {
      body += `<div class="sect"><div class="sect-title">${esc(tt("Filtre"))}</div><div class="tile-grid three">${FILTER_PRESETS.map((p) => `<button class="tile${it.filter.preset === p.id ? " is-on" : ""}" data-act="filter" data-val="${p.id}"><div class="tile-art photo" style="height:34px;filter:${previewCss(p.v)}"></div><small>${esc(tt(p.label))}</small></button>`).join("")}</div></div>`;
      body += `<div class="sect"><div class="sect-title">${esc(tt("Réglages"))}</div>${ADJUSTMENTS.map((a) => slider(a.label, `filter.${a.k}`, it.filter[a.k] || 0, a.min === 0 ? 0 : -100, 100, 1, "", 100)).join("")}
        <div class="row"><button class="btn ghost xs" data-act="reset-filter">${esc(tt("Réinitialiser"))}</button><button class="btn outline xs" data-act="filter-all">${esc(tt("Appliquer à tous les clips"))}</button></div></div>`;
    }
    return head(name, `<button class="btn ghost icon sm" data-act="delete" title="${esc(tt("Supprimer"))}">${ic("trash-2")}</button>`)
      + tabs([["general", type === "overlay" ? "Incrustation" : "Général"], ["frame", "Cadre"], ["color", "Couleur"]])
      + `<div class="insp-body">${body}</div>`;
  }

  function textPanel(it) {
    if (!["text", "style", "anim"].includes(inspTab)) inspTab = "text";
    let body = "";
    if (inspTab === "text") {
      body += `<label class="f"><span>${esc(tt(it.kind === "sticker" ? "Sticker" : "Contenu"))}</span><textarea class="input" data-k="text" rows="3">${esc(it.text)}</textarea></label>`;
      body += `<div class="grid2">${numF("Début (s)", "start", it.start)}${numF("Fin (s)", "end", it.end)}</div>`;
      if (it.kind !== "sticker") body += `<div class="sect"><div class="sect-title">${esc(tt("Style prêt à l'emploi"))}</div><div class="tile-grid">${TEXT_PRESETS.map((p) => `<button class="tile${it.preset === p.id ? " is-on" : ""}" data-act="text-preset" data-val="${p.id}"><div class="tile-art" style="${presetCss(p.s)}">${esc(tt(p.sample).split("\n")[0])}</div><small>${esc(tt(p.label))}</small></button>`).join("")}</div></div>`;
      if (it.kind !== "sticker") body += `<button class="btn outline sm" data-act="tts">${ic("volume-2")}${esc(tt("Lire ce texte en voix off"))}</button>`;
    } else if (inspTab === "style") {
      body += `<div class="grid2">${selectF("Police", "font", it.font, FONTS)}${selectF("Graisse", "weight", it.weight, [400, 500, 600, 700, 800, 900].map((w) => ({ id: w, label: String(w) })))}</div>`;
      body += slider("Taille", "size", it.size, 12, 400, 1);
      body += colorF("Couleur", "color", it.color, ["#ffffff", "#000000", "#ffd60a", "#ff375f", "#30d158", "#0a84ff", "#bf5af2", "#5ef1ff"]);
      body += colorF("Fond", "bg", it.bg, ["transparent", "rgba(0,0,0,0.55)", "rgba(255,255,255,0.88)", "#ffd60a", "#ff375f", "#0a84ff", "#111111"]);
      body += slider("Contour", "stroke", it.stroke || 0, 0, 24, 1);
      if (it.stroke) body += colorF("Couleur du contour", "strokeColor", it.strokeColor, ["#000000", "#ffffff", "#ff375f", "#0a84ff", "#ffd60a"]);
      body += `<div class="row">${checkF("Ombre", "shadow", it.shadow)}${checkF("Majuscules", "upper", it.upper)}</div>`;
      body += selectF("Halo néon", "glow", it.glow || "", [{ id: "", label: "Aucun" }, { id: "#00d5ff", label: "Cyan" }, { id: "#ff2fb4", label: "Rose" }, { id: "#ffd60a", label: "Jaune" }, { id: "#30d158", label: "Vert" }]);
      body += `<div class="row">${["left", "center", "right"].map((a) => `<button class="btn ${it.align === a ? "primary" : "outline"} xs" data-set="align" data-val="${a}">${esc(tt({ left: "Gauche", center: "Centre", right: "Droite" }[a]))}</button>`).join("")}</div>`;
      body += `<div class="sect"><div class="sect-title">${esc(tt("Position"))}</div>${slider("Horizontale", "x", it.x, 0, 100, 1, "%", 100)}${slider("Verticale", "y", it.y, 0, 100, 1, "%", 100)}${slider("Largeur max.", "maxW", it.maxW, 10, 100, 1, "%", 100)}${slider("Rotation", "rotate", it.rotate || 0, -180, 180, 1, "°")}</div>`;
    } else {
      body += selectF("Entrée", "anim.in", it.anim.in, TEXT_ANIMS_IN) + selectF("Sortie", "anim.out", it.anim.out, TEXT_ANIMS_OUT) + slider("Durée de l'animation", "anim.dur", it.anim.dur, 0.05, 3, 0.05, "s");
      body += `<p class="muted small">${esc(tt("Les animations se voient en lecture ; à l'arrêt, le texte reste affiché pour être réglé."))}</p>`;
    }
    return head(it.kind === "sticker" ? tt("Sticker") : it.kind === "caption" ? tt("Sous-titre") : tt("Texte"), `<button class="btn ghost icon sm" data-act="delete" title="${esc(tt("Supprimer"))}">${ic("trash-2")}</button>`)
      + tabs([["text", it.kind === "sticker" ? "Sticker" : "Texte"], ["style", "Style"], ["anim", "Animation"]])
      + `<div class="insp-body">${body}</div>`;
  }

  function audioPanel(it) {
    const kinds = [{ id: "music", label: "Musique" }, { id: "voice", label: "Voix" }, { id: "sfx", label: "Effet sonore" }];
    return head(it.src?.name || tt("Audio"), `<button class="btn ghost icon sm" data-act="delete" title="${esc(tt("Supprimer"))}">${ic("trash-2")}</button>`)
      + `<div class="insp-body">
        ${selectF("Type", "kind", it.kind, kinds)}
        <div class="sect"><div class="sect-title">${esc(tt("Placement"))}</div>${numF("Position (s)", "start", it.start)}<div class="grid2">${numF("Début dans le fichier", "in", it.in)}${numF("Fin dans le fichier", "out", it.out)}</div></div>
        <div class="sect"><div class="sect-title">${esc(tt("Son"))}</div>${slider("Volume", "volume", it.volume ?? 1, 0, 200, 1, "%", 100)}${slider("Vitesse", "speed", it.speed || 1, 0.25, 4, 0.05, "×")}${slider("Fondu d'entrée", "fadeIn", it.fadeIn || 0, 0, 10, 0.1, "s")}${slider("Fondu de sortie", "fadeOut", it.fadeOut || 0, 0, 10, 0.1, "s")}</div>
        <div class="sect"><div class="sect-title">${esc(tt("Outils"))}</div>
          ${it.kind === "music" ? `<button class="btn outline sm" data-act="beats">${ic("activity")}${esc(tt("Détecter le rythme et caler les photos"))}</button>` : `<button class="btn outline sm" data-act="captions-one">${ic("captions")}${esc(tt("Sous-titrer cette piste"))}</button>`}
          <button class="btn ghost sm" data-act="fit-music">${esc(tt("Ajuster à la durée du montage"))}</button>
        </div>
      </div>`;
  }

  function previewCss(v) {
    const p = [];
    if (v.brightness) p.push(`brightness(${1 + v.brightness})`);
    if (v.contrast) p.push(`contrast(${1 + v.contrast})`);
    if (v.saturation) p.push(`saturate(${Math.max(0, 1 + v.saturation)})`);
    if (v.hue) p.push(`hue-rotate(${v.hue * 180}deg)`);
    if (v.temperature > 0) p.push(`sepia(${v.temperature * 0.6})`);
    if (v.temperature < 0) p.push(`hue-rotate(${v.temperature * 25}deg)`);
    return p.join(" ") || "none";
  }
  function presetCss(s) {
    const font = (FONTS.find((f) => f.id === s.font) || FONTS[0]).css.replace(/"/g, "'");
    return `font-family:${font};font-weight:${s.weight || 700};color:${s.color};${s.bg && s.bg !== "transparent" ? `background:${s.bg};` : "background:#27272a;"}${s.stroke ? `-webkit-text-stroke:1px ${s.strokeColor};` : ""}${s.glow ? `text-shadow:0 0 8px ${s.glow};` : ""}${s.upper ? "text-transform:uppercase;" : ""}font-size:${s.size > 100 ? 17 : 14}px`;
  }

  let editing = false, editTimer = 0;
  function beginEdit() { if (!editing) { hist.push(P); editing = true; } clearTimeout(editTimer); editTimer = setTimeout(endEdit, 700); }
  function endEdit() { if (!editing) return; editing = false; save(); renderTimeline(); updateUndo(); }

  function bindInspector(item) {
    const box = $("inspector");
    const target = (k) => (k.startsWith("P.") ? [P, k.slice(2)] : [item, k]);
    const valueOf = (el) => {
      if (el.type === "checkbox") return el.checked;
      if (el.type === "range") return Number(el.value) / (Number(el.dataset.scale) || 1);
      if (el.type === "number") return Number(el.value);
      if (el.tagName === "SELECT" && /^-?\d+(\.\d+)?$/.test(el.value) && !/color|bg/.test(el.dataset.k)) return Number(el.value);
      return el.value;
    };
    const afterSet = (k) => {
      if (!item) return;
      if (item.kind === "video" && (k === "in" || k === "out")) item.out = Math.max(item.in + 0.1, item.out);
      if ("end" in item && k === "start" && item.end <= item.start) item.end = item.start + 0.5;
      if (k.startsWith("filter.")) item.filter.preset = "custom";
      if (k === "text" && item.kind !== "sticker") item.preset = item.preset || "plain";
    };
    box.oninput = (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      beginEdit();
      const [o, path] = target(k);
      setPath(o, path, valueOf(e.target));
      afterSet(k);
      const show = box.querySelector(`[data-show="${k}"]`);
      if (show && e.target.type === "range") {
        const v = valueOf(e.target), u = e.target.dataset.unit, sc = Number(e.target.dataset.scale) || 1;
        show.textContent = u === "%" ? `${Math.round(v * sc)} %` : u === "°" ? `${Math.round(v)}°` : u === "s" ? `${r2(v)} s` : u === "×" ? `×${r2(v)}` : `${r2(v * sc)}`;
      }
      if (k === "P.aspect" || k === "P.quality") resize();
      if (/^(in|out|dur|speed|start|end|transition\.dur)$/.test(k)) renderTimeline();
      sync(true); draw();
    };
    box.onchange = (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      endEdit();
      if (k === "P.bg.mode" || k === "stroke" || k === "kind") renderInspector();
    };
    box.onclick = async (e) => {
      const tb = e.target.closest("[data-tab-i]");
      if (tb) { inspTab = tb.dataset.tabI; renderInspector(); return; }
      const st = e.target.closest("[data-set]");
      if (st) {
        const k = st.dataset.set;
        let v = st.dataset.val;
        if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
        change(() => { const [o, path] = target(k); setPath(o, path, v); afterSet(k); });
        if (k === "P.bg.color") resize();
        return;
      }
      const a = e.target.closest("[data-act]");
      if (!a) return;
      const act = a.dataset.act, val = a.dataset.val;
      switch (act) {
        case "delete": removeSelected(); break;
        case "flipH": change(() => { item.transform.flipH = !item.transform.flipH; }); break;
        case "flipV": change(() => { item.transform.flipV = !item.transform.flipV; }); break;
        case "reset-tf": change(() => { item.transform = M.DEFAULT_TRANSFORM(); if (sel.type === "overlay") item.transform.scale = 0.42; }); break;
        case "filter": change(() => { item.filter = filterFromPreset(val); }); break;
        case "reset-filter": change(() => { item.filter = M.DEFAULT_FILTER(); }); break;
        case "filter-all": change(() => { for (const c of [...P.clips, ...P.overlays]) c.filter = { ...item.filter }; }); toast(tt("Filtre appliqué à tous les clips.")); break;
        case "transition": change(() => { item.transition = val === "none" ? null : { type: val, dur: item.transition?.dur || 0.5 }; }); break;
        case "transition-all": {
          const tr = item.transition;
          change(() => { P.clips.forEach((c, i) => { c.transition = i < P.clips.length - 1 && tr ? { ...tr } : null; }); });
          toast(tt("Transition appliquée à toutes les jonctions."));
          break;
        }
        case "text-preset": {
          const p = TEXT_PRESETS.find((x) => x.id === val);
          if (p) change(() => { const keep = { id: item.id, text: item.text, start: item.start, end: item.end, lane: item.lane }; Object.assign(item, M.newText({ ...structuredClone(p.s), ...keep, preset: p.id })); });
          break;
        }
        case "tts": await ttsVoice(item.text, item.start); break;
        case "beats": await beatSync({ musicId: item.id }); break;
        case "captions-one": await autoCaptions({ onlyId: item.id }); break;
        case "fit-music": change(() => { const T = M.mainTotal(P) || M.total(P); item.start = 0; item.out = Math.min(item.srcDur || item.out, item.in + T * (item.speed || 1)); item.fadeOut = Math.max(item.fadeOut, 2); }); break;
        case "clear-markers": change(() => { P.markers = []; }); break;
        default: break;
      }
    };
  }

  // ===== Panneaux de ressources ==============================================
  function setRes(id) {
    document.querySelectorAll("#res-rail [data-res]").forEach((b) => b.classList.toggle("is-on", b.dataset.res === id));
    document.querySelectorAll("#res-panel [data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== id; });
    store.set("res", id);
    if (id === "audio") renderAudioPane();
  }

  function renderAudioPane() {
    const pane = document.querySelector('[data-pane="audio"]');
    const tracks = ctx.files().filter((f) => f.kind === "audio");
    pane.innerHTML = `
      <div class="card"><h4>${ic("mic")}${esc(tt("Voix off"))}</h4><p>${esc(tt("Enregistrez votre voix pendant que le montage défile (sans le son, pour éviter l'écho)."))}</p>
        <button class="btn primary sm" id="rec-btn-panel">${ic("mic")}${esc(tt("Enregistrer depuis la tête de lecture"))}</button></div>
      <div class="card"><h4>${ic("volume-2")}${esc(tt("Voix de synthèse"))}</h4><p>${esc(tt("Lumen lit votre texte avec la voix locale choisie dans les Réglages."))}</p>
        <textarea class="input" id="tts-text" rows="3" placeholder="${esc(tt("Texte à lire…"))}"></textarea>
        <button class="btn outline sm" id="tts-go">${ic("sparkles")}${esc(tt("Générer à la tête de lecture"))}</button></div>
      <div class="pane-title">${ic("music")}${esc(tt("Musiques de vos sandboxes"))}</div>
      <div class="lib">${tracks.length ? tracks.map((f) => `<button class="lib-item" data-audio="${ctx.files().indexOf(f)}"><span class="lib-ic">${ic("music")}</span><span class="lib-tx"><b>${esc(f.name)}</b><small>${esc(f.sandbox)}</small></span><span class="lib-add">${ic("plus")}</span></button>`).join("") : `<p class="pane-hint">${esc(tt("Aucune musique : importez des MP3/M4A dans le panneau Médias."))}</p>`}</div>`;
    pane.querySelector("#rec-btn-panel").onclick = toggleRecord;
    pane.querySelector("#tts-go").onclick = async () => { const tx = pane.querySelector("#tts-text").value; if (await ttsVoice(tx, t)) pane.querySelector("#tts-text").value = ""; };
    pane.querySelectorAll("[data-audio]").forEach((b) => { b.onclick = () => add(ctx.files()[Number(b.dataset.audio)], { track: "audio", audioKind: "music", at: P.audio.some((m) => m.kind === "music") ? t : 0 }); });
    updateRecBtn();
  }

  function buildPanes() {
    const textPane = document.querySelector('[data-pane="text"]');
    textPane.innerHTML = `<div class="pane-title">${ic("type")}${esc(tt("Styles de texte"))}</div><p class="pane-hint">${esc(tt("Cliquez pour poser le texte à la tête de lecture."))}</p>
      <div class="tile-grid">${TEXT_PRESETS.map((p) => `<button class="tile" data-tp="${p.id}"><div class="tile-art" style="${presetCss(p.s)}">${esc(tt(p.sample).split("\n")[0])}</div><small>${esc(tt(p.label))}</small></button>`).join("")}</div>
      <div class="card"><h4>${ic("captions")}${esc(tt("Sous-titres automatiques"))}</h4><p>${esc(tt("Transcrit la parole des clips et voix off (Whisper, en local) et pose des légendes calées."))}</p><button class="btn outline sm" data-ai="captions">${ic("sparkles")}${esc(tt("Générer les sous-titres"))}</button></div>`;
    textPane.querySelectorAll("[data-tp]").forEach((b) => { b.onclick = () => addText({ preset: b.dataset.tp }); });

    document.querySelector('[data-pane="stickers"]').innerHTML = `<div class="pane-title">${ic("smile")}${esc(tt("Stickers"))}</div><p class="pane-hint">${esc(tt("Posés à la tête de lecture ; déplacez-les et redimensionnez-les dans l'aperçu."))}</p>
      <div class="tile-grid five">${STICKERS.map((s) => `<button class="tile sticker" data-st="${esc(s)}">${s}</button>`).join("")}</div>`;
    document.querySelectorAll("[data-st]").forEach((b) => { b.onclick = () => addSticker(b.dataset.st); });

    document.querySelector('[data-pane="filters"]').innerHTML = `<div class="pane-title">${ic("palette")}${esc(tt("Filtres"))}</div><p class="pane-hint">${esc(tt("S'applique au clip sélectionné (ou au clip sous la tête de lecture)."))}</p>
      <div class="tile-grid three">${FILTER_PRESETS.map((p) => `<button class="tile" data-fp="${p.id}"><div class="tile-art photo" style="filter:${previewCss(p.v)}"></div><small>${esc(tt(p.label))}</small></button>`).join("")}</div>
      <button class="btn outline sm" id="filter-all-btn">${esc(tt("Appliquer le dernier filtre à tous les clips"))}</button>`;
    let lastFilter = "vivid";
    document.querySelectorAll("[data-fp]").forEach((b) => {
      b.onclick = () => {
        lastFilter = b.dataset.fp;
        const f = selected();
        const it = f && (f.type === "clip" || f.type === "overlay") ? f.item : M.clipAt(P, t)?.clip;
        if (!it) { toast(tt("Sélectionnez un clip.")); return; }
        change(() => { it.filter = filterFromPreset(lastFilter); });
        if (!sel) select({ type: "clip", id: it.id });
      };
    });
    $("filter-all-btn").onclick = () => { change(() => { for (const c of [...P.clips, ...P.overlays]) c.filter = filterFromPreset(lastFilter); }); toast(tt("Filtre appliqué à tous les clips.")); };

    document.querySelector('[data-pane="transitions"]').innerHTML = `<div class="pane-title">${ic("blend")}${esc(tt("Transitions"))}</div><p class="pane-hint">${esc(tt("S'applique à la jonction sélectionnée (◆ sur la piste principale) ou après le clip sélectionné."))}</p>
      <div class="tile-grid three">${TRANSITIONS.map((x) => `<button class="tile" data-trp="${x.id}"><div class="tile-art photo" style="height:40px">${ic("blend")}</div><small>${esc(tt(x.label))}</small></button>`).join("")}</div>
      <label class="f"><span>${esc(tt("Durée"))}<em id="tr-dur-show">0.5 s</em></span><input class="range" type="range" id="tr-dur" min="0.1" max="2" step="0.05" value="0.5" /></label>
      <button class="btn outline sm" id="tr-all">${esc(tt("Appliquer à toutes les jonctions"))}</button>`;
    let trType = "fade";
    $("tr-dur").oninput = (e) => { $("tr-dur-show").textContent = `${e.target.value} s`; };
    document.querySelectorAll("[data-trp]").forEach((b) => {
      b.onclick = () => {
        trType = b.dataset.trp;
        let c = sel?.type === "transition" ? P.clips.find((x) => x.id === sel.id) : sel?.type === "clip" ? P.clips.find((x) => x.id === sel.id) : null;
        if (!c) { const h = M.clipAt(P, t); c = h?.clip; }
        if (!c || P.clips.indexOf(c) >= P.clips.length - 1) { toast(tt("Choisissez une jonction entre deux clips.")); return; }
        change(() => { c.transition = trType === "none" ? null : { type: trType, dur: Number($("tr-dur").value) }; });
        select({ type: "transition", id: c.id });
      };
    });
    $("tr-all").onclick = () => { change(() => { P.clips.forEach((c, i) => { c.transition = i < P.clips.length - 1 && trType !== "none" ? { type: trType, dur: Number($("tr-dur").value) } : null; }); }); toast(tt("Transition appliquée à toutes les jonctions.")); };

    document.querySelector('[data-pane="ai"]').innerHTML = `<div class="pane-title">${ic("sparkles")}${esc(tt("Outils intelligents"))}</div>
      <div class="ai-status" id="ai-status"></div><div class="progress" hidden><i id="ai-progress"></i></div>
      <div class="card"><h4>${ic("captions")}${esc(tt("Sous-titres automatiques"))}</h4><p>${esc(tt("Whisper en local : la parole devient des légendes courtes, calées au mot près."))}</p><button class="btn outline sm" data-ai="captions">${esc(tt("Générer"))}</button></div>
      <div class="card"><h4>${ic("scissors")}${esc(tt("Couper les silences"))}</h4><p>${esc(tt("Retire les blancs de plus de 0,6 s des clips vidéo (ou du clip sélectionné)."))}</p><button class="btn outline sm" data-ai="silences">${esc(tt("Couper"))}</button></div>
      <div class="card"><h4>${ic("activity")}${esc(tt("Caler sur le rythme"))}</h4><p>${esc(tt("Repère les temps forts de la musique et y cale les changements de photo."))}</p><button class="btn outline sm" data-ai="beats">${esc(tt("Analyser"))}</button></div>
      <div class="card"><h4>${ic("wand-sparkles")}${esc(tt("Montage automatique"))}</h4><p>${esc(tt("Transitions, filtre, mouvements, titre et musique, en un clic, selon un style."))}</p>
        <select class="select sm" id="auto-style"><option value="dynamic">${esc(tt("Dynamique"))}</option><option value="vlog">${esc(tt("Vlog"))}</option><option value="cinematic">${esc(tt("Cinématique"))}</option><option value="calm">${esc(tt("Doux"))}</option></select>
        <button class="btn outline sm" data-ai="auto">${esc(tt("Monter"))}</button></div>
      <div class="card"><h4>${ic("sparkles")}${esc(tt("Assistant de montage"))}</h4><p>${esc(tt("Décrivez ce que vous voulez : « fais un reel de 30 s avec mes photos de vacances, musique douce et sous-titres ».") )}</p><button class="btn primary sm" data-ai="open">${esc(tt("Ouvrir l'assistant"))}</button></div>`;
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ai]");
      if (!b) return;
      const a = b.dataset.ai;
      if (a === "captions") autoCaptions();
      else if (a === "silences") removeSilences({ onlyId: sel?.type === "clip" ? sel.id : null });
      else if (a === "beats") beatSync();
      else if (a === "auto") autoMontage({ style: $("auto-style")?.value || "dynamic" });
      else if (a === "open") ai?.open();
    });
  }

  // ===== Projets ==============================================================
  function loadProject(p) {
    pause();
    for (const id of [...els.keys()]) dropEl(id);
    P = M.migrate(p);
    hist.clear();
    sel = null; t = 0;
    save();
    $("ed-title").value = P.title;
    fillAspect();
    resize(); renderTimeline(); renderInspector(); updateUndo();
  }
  function renderProjectsMenu() {
    const menu = $("projects-menu");
    const list = [...index].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    menu.innerHTML = `<div class="menu-label">${esc(tt("Mes montages"))}</div>`
      + list.map((p) => `<button class="menu-item${p.id === P.id ? " is-on" : ""}" data-open="${p.id}">${ic("film")}${esc(p.title || tt("Sans titre"))}<small>${new Date(p.updated || Date.now()).toLocaleDateString()}</small></button>`).join("")
      + `<div class="menu-sep"></div>
        <button class="menu-item" data-pm="new">${ic("plus")}${esc(tt("Nouveau montage"))}</button>
        <button class="menu-item" data-pm="dup">${ic("copy")}${esc(tt("Dupliquer ce montage"))}</button>
        <button class="menu-item" data-pm="del">${ic("trash-2")}${esc(tt("Supprimer ce montage"))}</button>`;
  }
  async function projectAction(a, id) {
    $("projects-menu").hidden = true;
    if (id) { const raw = store.getJSON(`project:${id}`, null); if (raw) loadProject(raw); return; }
    if (a === "new") { loadProject(M.blankProject(tt("Mon montage"))); return; }
    if (a === "dup") { const c = structuredClone(P); c.id = M.uid("p"); c.title = `${P.title} ${tt("(copie)")}`; loadProject(c); toast(tt("Montage dupliqué.")); return; }
    if (a === "del") {
      if (!(await confirmSheet({ title: tt("Supprimer ce montage ?"), body: tt("Le projet sera effacé (les fichiers des sandboxes restent intacts)."), confirm: tt("Supprimer"), cancel: tt("Annuler"), danger: true }))) return;
      store.remove?.(`project:${P.id}`);
      index = index.filter((x) => x.id !== P.id);
      store.set("projects", index);
      const next = index[0] && store.getJSON(`project:${index[0].id}`, null);
      loadProject(next || M.blankProject(tt("Mon montage")));
    }
  }

  // ===== Export ==============================================================
  function pickMime(withSound = true) {
    // Sans son : un format VIDÉO SEULE — imposer l'AAC sans piste audio faisait
    // échouer l'enregistrement sous WebKit.
    const list = withSound
      ? ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      : ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    return list.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
  }

  async function openExport() {
    if (!M.total(P)) { toast(tt("Ajoutez d'abord des médias à la timeline.")); return; }
    if (!pickMime()) { toast(tt("Ce moteur ne sait pas enregistrer de vidéo.")); return; }
    if (!(await ensureSessionUnlocked({ invoke, reason: tt("Exporter la vidéo") }))) return;
    const list = await sandboxes();
    if (!list.length) { toast(tt("Créez d'abord une sandbox dans Fichiers.")); return; }
    const tgt = await targetSandbox();
    const form = $("export-form");
    form.quality.value = String(P.quality);
    form.fps.value = String(P.fps);
    form.sandbox.innerHTML = list.map((s) => `<option value="${esc(s.id)}"${s.id === tgt?.id ? " selected" : ""}>${esc(s.name)}</option>`).join("");
    form.name.value = `${(P.title || "Montage").replace(/[\\/:*?"<>|]+/g, " ").trim() || "Montage"} ${P.aspect.replace(":", "x")}`;
    const mime = pickMime(true);
    $("export-info").textContent = `${tt("Durée")} ${fmt(M.total(P))} · ${mime.includes("mp4") ? tt("MP4 natif") : ctx.ffmpeg() ? tt("WebM converti en MP4 (ffmpeg)") : tt("WebM (installez ffmpeg pour du MP4)")} · ${tt("l'export se fait en temps réel.")}`;
    $("export-settings").hidden = false;
    return new Promise((resolve) => {
      const close = () => { $("export-settings").hidden = true; form.onsubmit = null; resolve(null); };
      form.querySelector("[data-close]").onclick = close;
      form.onsubmit = async (e) => {
        e.preventDefault();
        $("export-settings").hidden = true;
        P.quality = Number(form.quality.value); P.fps = Number(form.fps.value);
        store.set("exportSandbox", form.sandbox.value);
        save();
        resolve(await exportVideo({ sandboxId: form.sandbox.value, name: form.name.value }));
      };
    });
  }

  async function exportVideo({ sandboxId = "", name = "" } = {}) {
    if (!M.total(P)) { toast(tt("Ajoutez d'abord des médias à la timeline.")); return null; }
    if (!(await ensureSessionUnlocked({ invoke, reason: tt("Exporter la vidéo") }))) return null;
    const sb = (await sandboxes()).find((s) => s.id === sandboxId) || (await targetSandbox());
    if (!sb) { toast(tt("Créez d'abord une sandbox dans Fichiers.")); return null; }
    const base = (name || `${P.title || "Montage"} ${P.aspect.replace(":", "x")}`).replace(/[\\/:*?"<>|]+/g, " ").trim() || "Montage";
    pause();
    sel = null; drawSel();
    resize(true);
    // Images prêtes AVANT d'enregistrer (sinon les premières secondes sont noires).
    await Promise.all([...P.clips, ...P.overlays].filter((c) => c.kind === "image").map((c) => {
      const el = imgFor(c.src);
      return el.complete && el.naturalWidth ? null : new Promise((r) => { el.addEventListener("load", r, { once: true }); el.addEventListener("error", r, { once: true }); setTimeout(r, 4000); });
    }));
    // Son seulement s'il y en a : une piste audio VIDE bloque le MediaRecorder
    // de WebKit, qui attend des échantillons et ne rend rien.
    const hasSound = P.audio.some((m) => (m.volume ?? 1) > 0) || [...P.clips, ...P.overlays].some((c) => c.kind === "video" && !c.mute && (c.volume ?? 1) > 0);
    const modal = $("export-modal");
    $("export-title").textContent = tt("Export en cours");
    $("export-actions").innerHTML = `<span class="grow"></span><button class="btn outline" id="export-cancel">${esc(tt("Annuler"))}</button>`;
    let cancelled = false;
    let mime = pickMime(hasSound);
    const record = (withSound) => new Promise((resolve) => {
      mime = pickMime(withSound);
      const stream = canvas.captureStream(P.fps || 30);
      const vtrack = stream.getVideoTracks()[0];
      if (withSound) { audio().resume(); for (const tr of mixDest.stream.getAudioTracks()) stream.addTrack(tr); }
      const bps = P.quality >= 2160 ? 40_000_000 : P.quality >= 1440 ? 16_000_000 : P.quality >= 1080 ? 8_000_000 : P.quality >= 720 ? 5_000_000 : 2_500_000;
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bps });
      const got = [];
      rec.ondataavailable = (e) => { if (e.data.size) got.push(e.data); };
      let done = false;
      const end = () => { if (!done) { done = true; clearInterval(pump); resolve(got); } };
      // WebKit n'émet une image que si le canvas « change » : sur une photo
      // fixe, presque rien. On réclame une image à chaque pas.
      const pump = setInterval(() => { try { vtrack?.requestFrame?.(); } catch {} }, 1000 / (P.fps || 30));
      const stop = () => {
        exporting = null; pause();
        if (rec.state !== "inactive") { try { rec.requestData(); } catch {} try { rec.stop(); } catch { end(); } }
        setTimeout(end, 3000); // filet : WebKit n'émet pas toujours « stop »
      };
      exporting = { progress: (p) => { $("export-bar").style.width = `${Math.round(p * 100)}%`; }, finish: stop };
      $("export-cancel").onclick = () => { cancelled = true; stop(); end(); };
      rec.onstop = () => setTimeout(end, 50);
      rec.onerror = () => end();
      rec.start(1000);
      // Le son part dans l'enregistrement, pas dans les haut-parleurs.
      audio(); master.gain.value = 0;
      t = 0; sync(true);
      setTimeout(() => playFrom(0), 400);
    });
    modal.hidden = false;
    $("export-bar").style.width = "0%";
    $("export-state").textContent = tt("Enregistrement en temps réel ({d})…", { d: fmt(M.total(P)) });
    let chunks = await record(hasSound);
    if (!chunks.length && hasSound && !cancelled) { $("export-bar").style.width = "0%"; chunks = await record(false); }
    if (master) master.gain.value = 1;
    resize(false);
    if (cancelled) { modal.hidden = true; toast(tt("Export annulé.")); return null; }
    if (!chunks.length) { modal.hidden = true; toast(tt("Le moteur n'a produit aucune image : réessayez, ou exportez en 720p.")); return null; }
    $("export-state").textContent = tt("Enregistrement du fichier…");
    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    try {
      const path = `Montages/${base}.${ext}`;
      await writeBlob(sb.id, path, blob, (p) => { $("export-bar").style.width = `${Math.round(p * 100)}%`; });
      let final = path;
      if (ext === "webm" && ctx.ffmpeg()) {
        $("export-state").textContent = tt("Conversion en MP4…");
        try { final = await invokeUnlocked(invoke, "media_convert", { sandboxId: sb.id, path, audioOnly: false }); } catch {}
      }
      ctx.rescan?.();
      $("export-title").textContent = tt("Vidéo exportée");
      $("export-bar").style.width = "100%";
      $("export-state").textContent = `${sb.name} / ${final}`;
      $("export-actions").innerHTML = `<span class="grow"></span><button class="btn outline" id="export-close">${esc(tt("Fermer"))}</button><button class="btn primary" id="export-play">${ic("play")}${esc(tt("Lire la vidéo"))}</button>`;
      $("export-close").onclick = () => { modal.hidden = true; };
      $("export-play").onclick = () => { modal.hidden = true; ctx.playFile?.({ sandboxId: sb.id, path: final }); };
      return { sandbox: sb.name, sandboxId: sb.id, path: final };
    } catch (e) {
      modal.hidden = true;
      toast(`${tt("Échec de l'export")} : ${e?.message || e}`);
      return null;
    }
  }

  // ===== Barre, raccourcis, démarrage ========================================
  function updateUndo() {
    $("ed-undo").disabled = !hist.canUndo;
    $("ed-redo").disabled = !hist.canRedo;
  }
  function undo() { const p = hist.undo(P); if (p) { P = M.migrate(p); after(); $("ed-title").value = P.title; fillAspect(); resize(); } }
  function redo() { const p = hist.redo(P); if (p) { P = M.migrate(p); after(); $("ed-title").value = P.title; fillAspect(); resize(); } }
  function fillAspect() {
    $("ed-aspect").innerHTML = Object.keys(M.ASPECTS).map((k) => `<option value="${k}"${P.aspect === k ? " selected" : ""}>${esc(tt(ASPECT_LABELS[k]))}</option>`).join("");
  }

  $("ed-title").value = P.title;
  fillAspect();
  $("ed-title").addEventListener("input", (e) => { P.title = e.target.value; save(); });
  $("ed-aspect").addEventListener("change", (e) => { change(() => { P.aspect = e.target.value; }); resize(); });
  $("ed-play").addEventListener("click", () => (playing ? pause() : playFrom(t >= M.total(P) - 0.05 ? 0 : t)));
  $("ed-back").addEventListener("click", () => { pause(); seek(0); $("timeline").scrollLeft = 0; });
  $("ed-fwd").addEventListener("click", () => { pause(); seek(M.total(P)); });
  $("ed-undo").addEventListener("click", undo);
  $("ed-redo").addEventListener("click", redo);
  $("ed-export").addEventListener("click", openExport);
  $("ed-projects").addEventListener("click", (e) => { e.stopPropagation(); renderProjectsMenu(); $("projects-menu").hidden = !$("projects-menu").hidden; });
  $("projects-menu").addEventListener("click", (e) => { const b = e.target.closest("[data-open],[data-pm]"); if (b) projectAction(b.dataset.pm, b.dataset.open); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) $("projects-menu").hidden = true; });
  $("add-color").addEventListener("click", () => addColorClip());
  $("tl-zoom").value = String(Math.round(pps));
  $("tl-zoom").addEventListener("input", (e) => setZoom(Number(e.target.value)));
  document.querySelectorAll("#res-rail [data-res]").forEach((b) => b.addEventListener("click", () => setRes(b.dataset.res)));
  $("tl-toolbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b) return;
    switch (b.dataset.tool) {
      case "split": split(); break;
      case "delete": removeSelected(); break;
      case "duplicate": duplicate(); break;
      case "freeze": freezeFrame(); break;
      case "detach": detachAudio(); break;
      case "marker": toggleMarker(); break;
      case "text": addText(); break;
      case "record": toggleRecord(); break;
      case "snap": snapOn = !snapOn; store.set("snap", snapOn ? "1" : "0"); b.classList.toggle("is-on", snapOn); break;
      case "zoom-in": setZoom(pps * 1.3); break;
      case "zoom-out": setZoom(pps / 1.3); break;
      case "fit": fitZoom(); break;
      default: break;
    }
  });
  document.querySelector('[data-tool="snap"]').classList.toggle("is-on", snapOn);
  document.addEventListener("keydown", (e) => {
    if ($("view-editor").hidden || e.target.matches("input, textarea, select") || !$("export-modal").hidden) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); }
    else if (mod) return;
    else if (e.code === "Space") { e.preventDefault(); $("ed-play").click(); }
    else if (e.key.toLowerCase() === "s") split();
    else if (e.key.toLowerCase() === "m") toggleMarker();
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); }
    else if (e.key === "Escape") select(null);
    else if (e.key === "Home") { pause(); seek(0); }
    else if (e.key === "End") { pause(); seek(M.total(P)); }
    else if (e.key === "ArrowLeft") { pause(); seek(t - (e.shiftKey ? 1 : 1 / (P.fps || 30))); }
    else if (e.key === "ArrowRight") { pause(); seek(t + (e.shiftKey ? 1 : 1 / (P.fps || 30))); }
  });

  wireTimeline();
  wireCanvas();
  buildPanes();
  setRes(store.get("res", "media"));
  resize();
  renderTimeline();
  renderInspector();
  updateUndo();
  setTimeout(() => seek(0), 300);

  // ===== API (assistant IA, intents, main.js) ================================
  const api = {
    get P() { return P; },
    get t() { return t; },
    files: () => ctx.files(),
    describe: () => M.describe(P),
    toast,
    add, addText, addSticker, addColorClip, split, removeItems, duplicate,
    change: (fn) => change(fn),
    select, seek: (x) => { pause(); seek(x); }, play: () => playFrom(t), pause,
    autoCaptions, removeSilences, beatSync, autoMontage, ttsVoice,
    exportVideo, openExport, undo,
    resize, model: M,
  };
  let ai = null;
  try { ai = mountEditorAI(api); } catch (e) { console.warn("[media] assistant indisponible", e); }
  $("ed-ai").addEventListener("click", () => ai?.toggle?.());

  return {
    add: (f) => add(f),
    pause,
    resize: () => { resize(); renderTimeline(); },
    api,
    unlocked: async () => { if (await isSessionUnlocked(invoke)) { thumbs.clear(); waves.clear(); for (const id of [...els.keys()]) dropEl(id); imgs.clear(); renderTimeline(); seek(t); } },
  };
}
