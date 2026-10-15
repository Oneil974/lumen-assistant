// Lumen XR — « Aube », le rituel du matin.
//
// Plus de diorama 3D : une SCÈNE DE VERRE. Des cartes translucides (même
// verre sombre que la barre et les panneaux) entrent l'une après l'autre en
// arc devant l'utilisateur, avec des icônes dessinées et animées. Lumen
// raconte la journée en quatre actes, la carte citée s'avance, les autres
// s'estompent :
//
//   I.   météo : grande carte au ciel animé (soleil qui tourne, nuages qui
//        passent, pluie/neige qui tombe), puis trois pastilles de mesures ;
//   II.  actualité : une carte par thème, en grille 2 × 2 ;
//   III. projets : une carte par projet, l'anneau d'avancement se remplit ;
//   IV.  la semaine : carte « agenda » dont les lignes glissent une à une ;
//   épilogue : tout se replie en une pastille « Ma journée » (un appui rejoue).
//
// Données : `morning_brief` (Rust). Narration écrite par du code, dite par
// la voix de Lumen depuis la carte concernée.

import * as THREE from "/lib/three.module.js";

const ACCENTS = ["#4d8dff", "#3fcf8e", "#ff7a59", "#ffc23d", "#b58cff"];
const DIST = 0.85;               // distance de la scène, en mètres

export function createMorning(ctx) {
  const { world, headPose, T, lang, roundRect, wrap, drawIcon, THEME } = ctx;
  const font = THEME.font;
  const root = new THREE.Group();
  root.visible = false;
  world.add(root);

  let running = null;
  const cards = [];
  const pickables = [];
  const anims = [];
  let brief = null;
  let pending = null;
  let lastT = performance.now();
  let lastDraw = 0;

  // ---------------------------------------------------------------- Cartes de verre
  /// Carte : plan texturé par un canvas. `draw(g, W, H, t)` est rappelée à
  /// chaque image tant que la carte est visible et `live` (icônes animées).
  function card(wm, hm, draw, { px = 900, live = false } = {}) {
    const c = document.createElement("canvas");
    c.width = px; c.height = Math.round(px * hm / wm);
    const g = c.getContext("2d");
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wm, hm), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
    mesh.renderOrder = 8;
    const api = {
      mesh, wm, hm, fade: 0, target: 0, focus: 1, focusTarget: 1, live, home: new THREE.Vector3(), delayUntil: 0,
      redraw(t = performance.now()) { g.clearRect(0, 0, c.width, c.height); draw(g, c.width, c.height, t); tex.needsUpdate = true; },
      show(on = true, delay = 0) { api.target = on ? 1 : 0; api.delayUntil = performance.now() + delay; if (on) sfx("pop", api.home); },
      place(x, y) { api.home.set(x, y, -Math.abs(x) * 0.45); mesh.position.copy(api.home); return api; },
    };
    api.redraw();
    setTimeout(() => api.redraw(), 300);   // icônes chargées en différé
    cards.push(api);
    root.add(mesh);
    return api;
  }
  /// Verre sombre façon visionOS : dégradé, reflet en haut, liseré lumineux.
  function glass(g, w, h, r = 56, accent = null) {
    g.save();
    roundRect(g, 4, 4, w - 8, h - 8, r);
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "rgba(70,76,96,0.72)"); grad.addColorStop(0.5, "rgba(30,33,46,0.66)"); grad.addColorStop(1, "rgba(18,20,28,0.72)");
    g.fillStyle = grad; g.fill();
    g.clip();
    const sheen = g.createLinearGradient(0, 0, 0, Math.min(h, 120));
    sheen.addColorStop(0, "rgba(255,255,255,0.16)"); sheen.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = sheen; g.fillRect(0, 0, w, 120);
    if (accent) {
      const glow = g.createRadialGradient(w * 0.15, 0, 0, w * 0.15, 0, w * 0.7);
      glow.addColorStop(0, accent + "55"); glow.addColorStop(1, accent + "00");
      g.fillStyle = glow; g.fillRect(0, 0, w, h);
    }
    g.restore();
    roundRect(g, 4, 4, w - 8, h - 8, r);
    g.lineWidth = 3; g.strokeStyle = "rgba(255,255,255,0.28)"; g.stroke();
  }
  function tx(g, s, x, y, size, weight = 600, align = "left", color = "#f4f5f8") {
    g.font = `${weight} ${size}px ${font}`; g.textAlign = align; g.textBaseline = "alphabetic";
    g.fillStyle = color; g.fillText(s, x, y);
  }
  /// Pastille ronde colorée portant une icône Lucide.
  function badge(g, icon, cx, cy, r, color) {
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    const gr = g.createLinearGradient(cx, cy - r, cx, cy + r);
    gr.addColorStop(0, color); gr.addColorStop(1, color + "aa");
    g.fillStyle = gr; g.fill();
    g.lineWidth = 2; g.strokeStyle = "rgba(255,255,255,0.45)"; g.stroke();
    drawIcon(g, icon, cx - r * 0.55, cy - r * 0.55, r * 1.1, "#ffffff", 2.2);
  }
  const ease = (k) => 1 - Math.pow(1 - Math.max(0, Math.min(1, k)), 3);

  // ---------------------------------------------------------------- Ciel animé (canvas)
  function cloud(g, x, y, s, alpha = 0.95) {
    g.fillStyle = `rgba(236,241,252,${alpha})`;
    g.beginPath();
    g.arc(x - s * 0.45, y + s * 0.1, s * 0.38, 0, Math.PI * 2);
    g.arc(x, y - s * 0.12, s * 0.5, 0, Math.PI * 2);
    g.arc(x + s * 0.48, y + s * 0.08, s * 0.4, 0, Math.PI * 2);
    g.fill();
    roundRect(g, x - s * 0.82, y + s * 0.05, s * 1.66, s * 0.44, s * 0.22); g.fill();
  }
  function sky(g, cx, cy, R, glyph, t) {
    const night = glyph === "moon";
    const sunny = glyph === "sun" || glyph === "cloud-sun";
    if (sunny || night) {
      const sx = glyph === "cloud-sun" ? cx + R * 0.25 : cx, sy = glyph === "cloud-sun" ? cy - R * 0.25 : cy;
      const sr = R * (glyph === "cloud-sun" ? 0.42 : 0.5);
      if (!night) {
        g.save(); g.translate(sx, sy); g.rotate(t / 4000);
        g.strokeStyle = "rgba(255,196,77,0.85)"; g.lineWidth = R * 0.07; g.lineCap = "round";
        for (let i = 0; i < 10; i++) { g.rotate(Math.PI / 5); g.beginPath(); g.moveTo(sr * 1.25, 0); g.lineTo(sr * (1.5 + 0.08 * Math.sin(t / 300 + i)), 0); g.stroke(); }
        g.restore();
      }
      const gr = g.createRadialGradient(sx - sr * 0.3, sy - sr * 0.3, sr * 0.1, sx, sy, sr);
      gr.addColorStop(0, night ? "#fdfcf2" : "#fff3c4"); gr.addColorStop(1, night ? "#c9cfee" : "#ffb53d");
      g.fillStyle = gr; g.beginPath(); g.arc(sx, sy, sr, 0, Math.PI * 2); g.fill();
      if (night) { g.fillStyle = "rgba(30,33,46,0.95)"; g.beginPath(); g.arc(sx + sr * 0.45, sy - sr * 0.25, sr * 0.85, 0, Math.PI * 2); g.fill(); }
    }
    const drift = Math.sin(t / 1800) * R * 0.08;
    if (glyph !== "sun" && !night) cloud(g, cx - R * 0.1 + drift, cy + R * 0.12, R * 0.55);
    if (/rain|snow|lightning|fog|cloud$/.test(glyph)) cloud(g, cx + R * 0.35 - drift, cy - R * 0.2, R * 0.38, 0.8);
    if (/rain|lightning/.test(glyph)) {
      g.strokeStyle = "rgba(142,197,255,0.9)"; g.lineWidth = R * 0.04; g.lineCap = "round";
      for (let i = 0; i < 7; i++) {
        const ph = ((t / 700 + i * 0.37) % 1), x = cx - R * 0.5 + i * R * 0.17, y = cy + R * 0.5 + ph * R * 0.6;
        g.globalAlpha = 1 - ph; g.beginPath(); g.moveTo(x, y); g.lineTo(x - R * 0.05, y + R * 0.14); g.stroke();
      }
      g.globalAlpha = 1;
    }
    if (/snow/.test(glyph)) {
      g.fillStyle = "#ffffff";
      for (let i = 0; i < 9; i++) {
        const ph = ((t / 2400 + i * 0.29) % 1), x = cx - R * 0.55 + i * R * 0.14 + Math.sin(t / 500 + i) * R * 0.04, y = cy + R * 0.45 + ph * R * 0.7;
        g.globalAlpha = 1 - ph; g.beginPath(); g.arc(x, y, R * 0.035, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    }
    if (/lightning/.test(glyph) && Math.sin(t / 260) > 0.93) {
      g.fillStyle = "#ffe066"; g.beginPath();
      g.moveTo(cx, cy + R * 0.3); g.lineTo(cx - R * 0.12, cy + R * 0.62); g.lineTo(cx + R * 0.02, cy + R * 0.6); g.lineTo(cx - R * 0.06, cy + R * 0.9); g.lineTo(cx + R * 0.16, cy + R * 0.5); g.lineTo(cx + R * 0.02, cy + R * 0.52); g.fill();
    }
  }

  // ---------------------------------------------------------------- Sons
  function toWorld(local) { root.updateMatrixWorld(true); return root.localToWorld(local.clone()); }
  function sfx(kind, pos = null) {
    const ac = ctx.audio?.();
    if (!ac) return;
    const t = ac.currentTime;
    let out = ac.destination;
    if (pos) { const p = toWorld(pos); const pan = new PannerNode(ac, { panningModel: "HRTF", refDistance: 0.6, positionX: p.x, positionY: p.y, positionZ: p.z }); pan.connect(ac.destination); out = pan; }
    const tone = (f0, f1, dur, vol, type = "sine", delay = 0) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t + delay); o.frequency.exponentialRampToValueAtTime(f1, t + delay + dur);
      g.gain.setValueAtTime(0.0001, t + delay); g.gain.exponentialRampToValueAtTime(vol, t + delay + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
      o.connect(g).connect(out); o.start(t + delay); o.stop(t + delay + dur + 0.05);
    };
    if (kind === "bowl") [220, 331, 441, 662].forEach((f, i) => tone(f, f * 0.995, 4.5, 0.05 / (i + 1)));
    else if (kind === "pop") tone(520, 880, 0.08, 0.035);
    else if (kind === "build") { tone(330, 495, 0.18, 0.04); tone(660, 990, 0.25, 0.03, "sine", 0.12); }
    else if (kind === "chime") { tone(880, 880, 0.6, 0.05); tone(1320, 1320, 0.8, 0.03, "sine", 0.08); }
    else if (kind === "tick") tone(1200, 900, 0.05, 0.03);
    else if (kind === "fold") { tone(700, 300, 0.5, 0.05); tone(990, 440, 0.6, 0.03, "sine", 0.05); }
  }

  // ---------------------------------------------------------------- Narration
  function say(text, pos = null, minMs = 0) {
    if (!text) return Promise.resolve();
    const wp = pos ? toWorld(pos) : null;
    ctx.speak(text, wp ? { pos: () => wp } : {});
    const t0 = performance.now();
    const est = Math.min(14000, 900 + text.split(/\s+/).length * 340);
    return new Promise((resolve) => {
      const tick = () => {
        if (!running || running.skipping) return resolve();
        const el = performance.now() - t0;
        if ((ctx.voiceOn() ? (!ctx.isSpeaking() && el > 700) : el > est) && el > minMs) return resolve();
        if (el > 30000) return resolve();
        setTimeout(tick, 120);
      };
      setTimeout(tick, 300);
    });
  }
  const wait = (ms) => new Promise((r) => { const t0 = performance.now(); const tick = () => (!running || running.skipping || performance.now() - t0 > ms ? r() : setTimeout(tick, 60)); tick(); });
  const fmtHour = (ms) => { const d = new Date(ms); return `${d.getHours()} h${d.getMinutes() ? ` ${String(d.getMinutes()).padStart(2, "0")}` : ""}`; };
  function whenText(ms) {
    const d = new Date(ms), now = new Date();
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
    const day = days === 0 ? T("aujourd'hui", "today") : days === 1 ? T("demain", "tomorrow") : d.toLocaleDateString(lang === "en" ? "en-GB" : "fr-FR", { weekday: "long" });
    return `${day} ${T("à", "at")} ${fmtHour(ms)}`;
  }
  /// La carte citée s'avance, les autres s'estompent.
  function spotlight(active) { for (const c of cards) c.focusTarget = !active || c === active ? 1 : 0.45; }
  function clearAct() { for (const c of cards) if (!c.keep) c.show(false); spotlight(null); return wait(450).then(() => { purge(); }); }
  function purge() {
    for (const c of [...cards]) { if (c.keep && running) continue; cards.splice(cards.indexOf(c), 1); root.remove(c.mesh); c.mesh.material.map?.dispose(); c.mesh.material.dispose(); c.mesh.geometry.dispose(); }
    pickables.length = 0;
    for (const c of cards) if (c.keep) pickables.push(c.mesh);
  }
  function clickable(c, onClick) { c.mesh.userData.morning = { onClick }; pickables.push(c.mesh); }

  // ---------------------------------------------------------------- Ouverture
  async function actIntro(greet) {
    const date = new Date().toLocaleDateString(lang === "en" ? "en-GB" : "fr-FR", { weekday: "long", day: "numeric", month: "long" });
    const t0 = performance.now();
    const c = card(0.34, 0.12, (g, W, H, t) => {
      glass(g, W, H, H / 2, "#ffc23d");
      const k = ease((t - t0) / 1600);
      // Petit lever de soleil : le disque monte derrière l'horizon.
      g.save(); roundRect(g, 30, 20, 150, H - 40, 40); g.clip();
      const sy = H - 30 - k * (H * 0.42);
      const gr = g.createRadialGradient(105, sy, 4, 105, sy, 60);
      gr.addColorStop(0, "#fff3c4"); gr.addColorStop(1, "#ff9d2e");
      g.fillStyle = gr; g.beginPath(); g.arc(105, sy, 46, 0, Math.PI * 2); g.fill();
      g.fillStyle = "rgba(255,255,255,0.25)"; g.fillRect(30, H - 52, 150, 2);
      g.restore();
      tx(g, greet.replace(/\.$/, ""), 210, H / 2 - 6, 64, 700);
      tx(g, date.charAt(0).toUpperCase() + date.slice(1), 212, H / 2 + 52, 36, 500, "left", "rgba(244,245,248,0.72)");
    }, { live: true }).place(0, 0.02);
    c.show();
    return c;
  }

  // ---------------------------------------------------------------- Acte I : météo
  async function actWeather() {
    const w = brief?.weather;
    sfx("chime");
    const main = card(0.36, 0.2, (g, W, H, t) => {
      glass(g, W, H, 64, "#4d8dff");
      if (!w) { tx(g, T("Météo indisponible", "Weather unavailable"), 60, H / 2, 54); return; }
      sky(g, W - 210, H / 2 - 10, 150, w.glyph || "cloud-sun", t);
      tx(g, w.city || brief.city || "", 60, 100, 50, 700);
      tx(g, `${Math.round(w.temp)}°`, 52, 300, 190, 300);
      tx(g, `${w.label} · ${T("max", "H")} ${Math.round(w.max)}°  ${T("min", "L")} ${Math.round(w.min)}°`, 60, H - 56, 36, 500, "left", "rgba(244,245,248,0.8)");
    }, { live: true }).place(0, 0.05);
    main.show();
    if (w) {
      const stats = [["cloud-rain", T("Pluie", "Rain"), `${Math.round(w.rain || 0)} %`, "#4d8dff"], ["droplet", T("Humidité", "Humidity"), `${Math.round(w.humidity || 0)} %`, "#3fcf8e"], ["wind", T("Vent", "Wind"), `${Math.round(w.wind || 0)} km/h`, "#b58cff"]];
      stats.forEach(([icon, k, v, col], i) => {
        const s = card(0.112, 0.06, (g, W, H) => {
          glass(g, W, H, H / 2);
          badge(g, icon, H / 2 + 6, H / 2, H / 2 - 26, col);
          tx(g, k, H + 10, H / 2 - 6, 34, 500, "left", "rgba(244,245,248,0.7)");
          tx(g, v, H + 10, H / 2 + 44, 48, 700);
        }, { px: 600 }).place((i - 1) * 0.122, -0.1);
        s.show(true, 500 + i * 220);
      });
    }
    await say(weatherLine(w, adviceFor(w)), main.home, 2500);
  }
  function adviceFor(w) {
    if (!w) return "";
    if ((w.rain || 0) >= 50) return T("Prends un parapluie.", "Take an umbrella.");
    if (w.max >= 28) return T("Pense à t'hydrater.", "Stay hydrated.");
    if (w.min <= 3) return T("Couvre-toi bien.", "Wrap up warm.");
    if ((w.wind || 0) >= 40) return T("Ça va souffler.", "It'll be windy.");
    return T("Belle journée pour sortir.", "A nice day to go out.");
  }
  function weatherLine(w, advice) {
    if (!w) return T("Je n'ai pas pu lire la météo ce matin.", "I couldn't get the weather this morning.");
    return T(`À ${w.city || brief.city}, ${String(w.label).toLowerCase()}, ${Math.round(w.temp)} degrés, entre ${Math.round(w.min)} et ${Math.round(w.max)} aujourd'hui. ${advice}`,
      `In ${w.city || brief.city}, ${String(w.label).toLowerCase()}, ${Math.round(w.temp)} degrees, between ${Math.round(w.min)} and ${Math.round(w.max)} today. ${advice}`);
  }

  // ---------------------------------------------------------------- Acte II : actualité
  async function actNews() {
    const topics = (brief?.news || []).filter((n) => n.items?.length).slice(0, 4);
    if (!topics.length) { await say(T("Pas d'actualité sur tes thèmes ce matin.", "No news on your topics this morning.")); return; }
    const slots = topics.length <= 2 ? [[-0.125, 0.02], [0.125, 0.02]] : [[-0.125, 0.09], [0.125, 0.09], [-0.125, -0.055], [0.125, -0.055]];
    for (let i = 0; i < topics.length; i++) {
      const tp = topics[i], color = ACCENTS[i % ACCENTS.length];
      const c = card(0.235, 0.13, (g, W, H) => {
        glass(g, W, H, 48, color);
        badge(g, "newspaper", 76, 76, 38, color);
        tx(g, tp.topic.toUpperCase().slice(0, 26), 132, 90, 32, 800, "left", "rgba(244,245,248,0.85)");
        g.font = `700 44px ${font}`;
        wrap(g, tp.items[0].title, W - 100).slice(0, 3).forEach((l, k) => tx(g, l, 50, 186 + k * 56, 44, 700));
        tx(g, `${tp.items[0].source || ""}${tp.items.length > 1 ? `  ·  +${tp.items.length - 1}` : ""}`, 50, H - 36, 28, 500, "left", "rgba(244,245,248,0.6)");
      }).place(...slots[i]);
      clickable(c, () => ctx.showDetail?.(tp.items.map((it) => `**${it.title}**\n${it.source || ""}${it.link ? ` — [${T("lire", "read")}](${it.link})` : ""}`).join("\n\n"), tp.topic));
      c.show();
      spotlight(c);
      await say(T(`Côté ${tp.topic} : ${tp.items[0].title}.`, `On ${tp.topic}: ${tp.items[0].title}.`), c.home);
      if (!running) return;
    }
    spotlight(null);
    await wait(600);
  }

  // ---------------------------------------------------------------- Acte III : projets
  async function actProjects() {
    const projects = (brief?.projects || []).slice(0, 3);
    if (!projects.length) { await say(T("Aucun projet suivi : demande à l'Intendant du matin d'en créer.", "No project followed: ask the Morning steward to create some.")); return; }
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i], color = ACCENTS[(i + 1) % ACCENTS.length], pct = Math.round(p.progress * 100);
      const anim = { t0: 0 };
      const c = card(0.2, 0.24, (g, W, H, t) => {
        glass(g, W, H, 56, color);
        const k = anim.t0 ? ease((t - anim.t0) / 1400) : 0;
        const cx = W / 2, cy = 250, R = 130;
        g.lineWidth = 26; g.lineCap = "round";
        g.strokeStyle = "rgba(255,255,255,0.12)"; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = color; g.beginPath(); g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.01, p.progress * k)); g.stroke();
        if (p.progress >= 1 && k >= 1) drawIcon(g, "check", cx - 60, cy - 60, 120, "#ffffff", 2.6);
        else tx(g, `${Math.round(pct * k)}%`, cx, cy + 30, 86, 700, "center");
        g.font = `700 50px ${font}`;
        tx(g, (wrap(g, p.name, W - 80)[0] || ""), cx, 470, 50, 700, "center");
        g.font = `500 32px ${font}`;
        wrap(g, p.goal || T("Pas d'objectif défini", "No goal set"), W - 90).slice(0, 2).forEach((l, kk) => tx(g, l, cx, 528 + kk * 42, 32, 500, "center", "rgba(244,245,248,0.72)"));
        if (p.next) { roundRect(g, 40, H - 132, W - 80, 84, 42); g.fillStyle = "rgba(255,255,255,0.1)"; g.fill(); g.font = `600 32px ${font}`; tx(g, `→ ${(wrap(g, p.next, W - 150)[0] || "")}`, 70, H - 78, 32, 600); }
      }, { live: true }).place((i - (projects.length - 1) / 2) * 0.215, 0.02);
      clickable(c, () => ctx.showDetail?.(`**${p.name}** — ${pct} %\n\n${p.goal || ""}\n\n${T("Étapes faites", "Steps done")} : ${p.done}/${p.total}${p.next ? `\n\n${T("Prochaine étape", "Next step")} : ${p.next}` : ""}`, p.name));
      c.show();
      spotlight(c);
      anim.t0 = performance.now() + 250;
      setTimeout(() => sfx("build", c.home), 1500);
      await say(p.progress >= 1 ? T(`${p.name} est terminé, bravo !`, `${p.name} is done, well done!`)
        : T(`${p.name} : ${pct} %${p.next ? `, prochaine étape : ${p.next}` : ""}.`, `${p.name}: ${pct}%${p.next ? `, next step: ${p.next}` : ""}.`), c.home);
      if (!running) return;
    }
    spotlight(null);
    await wait(600);
  }

  // ---------------------------------------------------------------- Acte IV : la semaine
  async function actAgenda() {
    const events = (brief?.events || []).slice(0, 5);
    if (!events.length) { await say(T("Ton agenda est libre cette semaine.", "Your calendar is clear this week.")); return; }
    const rows = events.map(() => ({ t0: 0 }));
    const st = { current: -1 };
    const ROW = 104;
    const c = card(0.38, 0.1 + events.length * 0.044, (g, W, H, t) => {
      glass(g, W, H, 56, "#ff7a59");
      badge(g, "calendar", 78, 76, 38, "#ff7a59");
      tx(g, T("Ta semaine", "Your week"), 134, 92, 46, 700);
      // Fil du temps vertical, pastilles qui s'allument au passage.
      g.fillStyle = "rgba(255,255,255,0.14)"; g.fillRect(77, 150, 3, H - 190);
      events.forEach((e, i) => {
        const r = rows[i]; if (!r.t0) return;
        const k = ease((t - r.t0) / 500), y = 150 + i * ROW + ROW / 2, x = 40 + (1 - k) * 60;
        const isToday = new Date(e.at).toDateString() === new Date().toDateString();
        g.globalAlpha = k;
        if (i === st.current) { roundRect(g, 110, y - ROW / 2 + 8, W - 150, ROW - 16, 30); g.fillStyle = "rgba(255,255,255,0.10)"; g.fill(); }
        g.beginPath(); g.arc(78, y, 13, 0, Math.PI * 2); g.fillStyle = isToday ? "#ffc23d" : "#ff7a59"; g.fill();
        tx(g, whenText(e.at), x + 100, y - 8, 30, 600, "left", isToday ? "#ffd977" : "rgba(244,245,248,0.65)");
        g.font = `600 38px ${font}`;
        tx(g, (wrap(g, e.title, W - x - 160)[0] || ""), x + 100, y + 36, 38, 600);
        g.globalAlpha = 1;
      });
    }, { live: true }).place(0, 0.02);
    clickable(c, () => ctx.showDetail?.(events.map((e) => `**${e.title}** — ${whenText(e.at)}${e.note ? `\n${e.note}` : ""}`).join("\n\n"), T("Ta semaine", "Your week")));
    c.show();
    const today = events.filter((e) => new Date(e.at).toDateString() === new Date().toDateString()).length;
    await say(today ? T(`Aujourd'hui, ${today} rendez-vous.`, `Today, ${today} appointment${today > 1 ? "s" : ""}.`) : T("Rien aujourd'hui ; voici la semaine.", "Nothing today; here's the week."), c.home);
    for (let i = 0; i < events.length; i++) {
      if (!running) return;
      rows[i].t0 = performance.now(); st.current = i;
      sfx("tick", c.home);
      await say(`${whenText(events[i].at)} : ${events[i].title}.`, c.home, 1200);
    }
    st.current = -1;
    const more = (brief?.events || []).length - events.length;
    if (more > 0) await say(T(`Et ${more} autre${more > 1 ? "s" : ""} dans la semaine.`, `And ${more} more this week.`));
  }

  // ---------------------------------------------------------------- Déroulé
  function anchor() {
    const { pos, quat } = headPose();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat).setY(0).normalize();
    const center = pos.clone().addScaledVector(fwd, DIST).add(new THREE.Vector3(0, -0.08, 0));
    world.updateMatrixWorld(true);
    root.position.copy(world.worldToLocal(center.clone()));
    const lu = world.worldToLocal(pos.clone());
    root.rotation.set(0, Math.atan2(lu.x - root.position.x, lu.z - root.position.z), 0);
    root.scale.setScalar(1);
  }
  async function run() {
    running = { skipping: false };
    try {
      purge();
      anims.length = 0;
      anchor();
      root.visible = true;
      ctx.ambience?.(true);
      sfx("bowl");
      ctx.orbOver?.(toWorld(new THREE.Vector3(0.3, 0.22, -0.05)));
      const h = new Date().getHours();
      const greet = h < 12 ? T("Bonjour.", "Good morning.") : h < 18 ? T("Bon après-midi.", "Good afternoon.") : T("Bonsoir.", "Good evening.");
      // « Quitter » : toujours là pendant le rituel (le reste de Lumen est masqué).
      const exit = card(0.17, 0.055, (g, W, H) => {
        glass(g, W, H, H / 2);
        drawIcon(g, "x", 26, H / 2 - 20, 40, "#f4f5f8", 2.4);
        tx(g, T("Quitter", "Exit"), 82, H / 2 + 14, 38, 600);
      }, { px: 520 }).place(-0.3, 0.22);
      exit.keep = true; clickable(exit, () => stop()); exit.show();
      await actIntro(greet);
      const [data] = await Promise.all([fetchBrief(), say(`${greet} ${T("On regarde ta journée ensemble ?", "Shall we look at your day together?")}`)]);
      brief = data;
      if (!running) return;
      for (const act of [actWeather, actNews, actProjects, actAgenda]) {
        if (!running) return;
        await clearAct();
        running.skipping = false;
        await act();
        await wait(400);
      }
      if (running) await epilogue();
    } finally {
      running = null;
      ctx.ambience?.(false);
      ctx.orbHome?.();
    }
  }
  async function epilogue() {
    await clearAct();
    for (const c of cards) if (c.keep) c.show(false);
    ctx.ambience?.(false);
    sfx("fold");
    const pill = card(0.2, 0.055, (g, W, H) => {
      glass(g, W, H, H / 2, "#ffc23d");
      badge(g, "sunrise", H / 2 + 4, H / 2, H / 2 - 18, "#ff9d2e");
      tx(g, T("Ma journée", "My day"), H + 16, H / 2 - 2, 44, 700);
      tx(g, T("Toucher pour rejouer", "Tap to replay"), H + 16, H / 2 + 42, 30, 500, "left", "rgba(244,245,248,0.6)");
    }, { px: 700 }).place(0, -0.1);
    clickable(pill, () => start());
    pill.show();
    await say(T("Voilà pour ce matin. Belle journée !", "That's it for this morning. Have a great day!"));
    try { localStorage.setItem("xrMorningLast", new Date().toDateString()); } catch {}
    // La pastille reste un moment puis s'efface d'elle-même.
    setTimeout(() => { if (!running && cards.includes(pill)) { pill.show(false); setTimeout(() => { if (!running) { purge(); root.visible = false; } }, 600); } }, 45000);
  }

  // ---------------------------------------------------------------- Données
  let briefSeq = 0;
  function fetchBrief() {
    const id = ++briefSeq;
    ctx.send({ type: "xr-morning-brief", id });
    return new Promise((resolve) => {
      pending = { id, resolve };
      setTimeout(() => { if (pending?.id === id) { pending = null; resolve({ city: "", weather: null, news: [], projects: [], events: [] }); } }, 20000);
    });
  }
  function start() { if (!running) run(); }
  function stop() {
    if (!running) return;
    running = null;
    ctx.stopSpeaking?.();
    ctx.ambience?.(false);
    ctx.orbHome?.();
    for (const c of cards) c.show(false);
    setTimeout(() => { if (!running) { purge(); root.visible = false; } }, 600);
  }

  // ---------------------------------------------------------------- Boucle
  const _head = new THREE.Vector3();
  function tick(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (!root.visible) return;
    for (let i = anims.length - 1; i >= 0; i--) if (anims[i](dt, now) === false) anims.splice(i, 1);
    _head.copy(headPose().pos);
    const reduce = ctx.settings?.reducedMotion;
    const redraw = now - lastDraw > 33;   // icônes animées à ~30 i/s
    if (redraw) lastDraw = now;
    for (const c of cards) {
      const want = now >= c.delayUntil ? c.target : 0;
      c.fade += (want - c.fade) * Math.min(1, dt * 6);
      c.focus += (c.focusTarget - c.focus) * Math.min(1, dt * 5);
      c.mesh.material.opacity = c.fade * (0.35 + 0.65 * c.focus);
      c.mesh.visible = c.fade > 0.01;
      if (!c.mesh.visible) continue;
      // Entrée : monte de 4 cm et grandit ; la carte citée s'avance de 3 cm.
      const rise = reduce ? 0 : (1 - c.fade) * -0.04;
      c.mesh.position.set(c.home.x, c.home.y + rise + (reduce ? 0 : Math.sin(now / 1400 + c.home.x * 9) * 0.002), c.home.z + (c.focus - 0.45) / 0.55 * 0.03);
      c.mesh.scale.setScalar((reduce ? 1 : 0.9 + 0.1 * c.fade) * (0.94 + 0.06 * c.focus));
      c.mesh.lookAt(_head);
      if (c.live && redraw) c.redraw(now);
    }
  }

  function onMessage(msg) {
    if (msg.type !== "xr-morning") return false;
    if (pending && pending.id === msg.id) { const p = pending; pending = null; p.resolve(msg.brief || {}); }
    return true;
  }

  // ---------------------------------------------------------------- Voix
  const START_RE = /^\s*(?:lumen[, ]*)?(?:(?:lance|démarre|demarre|joue|rejoue|montre)[- ](?:moi )?(?:le |mon )?(?:rituel|brief(?:ing)?)(?: du matin)?|(?:mon |le )?rituel du matin|(?:mon )?brief(?:ing)? du matin|morning (?:ritual|brief))/i;
  const HELLO_RE = /^\s*(?:lumen[, ]*)?(?:bonjour|good morning)(?:\s+lumen)?[\s.!]*$/i;
  const SKIP_RE = /^\s*(?:lumen[, ]*)?(?:passe|suivant|la suite|next|skip)\b/i;
  const STOP_RE = /^\s*(?:lumen[, ]*)?(?:arr[eê]te(?: le rituel)?|stop|termine|c'est bon)\b/i;
  function handleUtterance(text) {
    if (running) {
      if (SKIP_RE.test(text)) { running.skipping = true; ctx.stopSpeaking?.(); return true; }
      if (STOP_RE.test(text)) { stop(); return true; }
    }
    if (START_RE.test(text) || (HELLO_RE.test(text) && new Date().getHours() < 12)) { start(); return true; }
    return false;
  }
  function maybeAuto(enabled) {
    if (!enabled || running || new Date().getHours() >= 11) return;
    let last = "";
    try { last = localStorage.getItem("xrMorningLast") || ""; } catch {}
    if (last === new Date().toDateString()) return;
    setTimeout(start, 3500);
  }

  return {
    start, stop, tick, onMessage, handleUtterance, maybeAuto,
    get running() { return !!running; },
    pickables: () => (root.visible ? pickables.filter((m) => m.visible !== false) : []),
  };
}
