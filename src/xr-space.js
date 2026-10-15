// Lumen XR — Lumen agit dans la pièce.
//
// Des objets posés dans l'espace, ancrés comme les panneaux (xr-spatial.js) et
// mémorisés d'une session à l'autre :
//
//   • MINUTEURS  — posés là où on regarde (au-dessus des plaques…), anneau qui
//                  se vide, alarme en son spatial DEPUIS le minuteur ;
//   • RAPPELS    — « rappelle-moi de sortir le linge dans 20 minutes » : carte
//                  posée sur place + rappel du bureau (notifications, mobile) ;
//   • POST-IT    — notes dictées, collées sur place, copiées dans l'app Notes ;
//   • OBJETS     — « souviens-toi où j'ai posé mes clés » : repère + photo ;
//                  « où sont mes clés ? » : un faisceau part de l'orbe vers eux ;
//   • DOMOTIQUE  — une commande flottante posée à côté de la lampe ; « éteins
//                  ça » en la regardant, ou un appui du doigt.
//
// Les commandes vocales sont reconnues ICI (expressions simples FR/EN) avant
// d'aller au modèle : « mets un minuteur de 10 minutes » ne doit pas attendre
// une réponse d'IA.

const LS_KEY = "xrSpace";
const NUM = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, quinze: 15, vingt: 20, "vingt-cinq": 25, trente: 30, quarante: 40, "quarante-cinq": 45, soixante: 60,
  one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, sixty: 60,
  "a": 1, an: 1, demi: 0.5, half: 0.5,
};
const toNum = (w) => {
  const v = Number(String(w).replace(",", "."));
  return Number.isFinite(v) ? v : NUM[String(w).toLowerCase()] ?? NaN;
};
const unitMs = (u) => {
  u = String(u || "").toLowerCase();
  if (/^s/.test(u)) return 1000;
  if (/^h/.test(u)) return 3600000;
  return 60000;
};

export function createSpace(ctx) {
  const {
    THREE, scene, world, Panel, THEME, wrap, roundRect, drawIcon, addPanel, removePanel, send, api, T, toast, lang,
    headPose, faceHead, gazePoint, audio, earcon, say, captureFrame, dictate, orbWorld, runIntent, setWorldPosition,
  } = ctx;
  const font = THEME.font;
  const items = new Map(); // id → { data, panel, pin }
  let devices = [];        // objets domotiques connus (xr-domo)
  const deviceState = new Map();

  // ---- Persistance -----------------------------------------------------------
  function persist() {
    const list = [...items.values()].map(({ data, panel }) => ({
      ...data,
      pos: panel.object.position.toArray().map((v) => +v.toFixed(3)),
      q: panel.object.quaternion.toArray().map((v) => +v.toFixed(4)),
    }));
    try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch {}
  }
  function restore() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(LS_KEY) || "[]") || []; } catch {}
    for (const d of list) create(d, { restore: true });
  }

  const uid = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---- Son spatial : alarme qui sort de l'objet ----------------------------
  function chimeAt(obj, urgent = false) {
    const ac = audio();
    if (!ac) return;
    const p = obj.getWorldPosition(new THREE.Vector3());
    const pan = new PannerNode(ac, { panningModel: "HRTF", distanceModel: "inverse", refDistance: 1, rolloffFactor: 0.8, positionX: p.x, positionY: p.y, positionZ: p.z });
    pan.connect(ac.destination);
    const t = ac.currentTime;
    (urgent ? [880, 1175, 880, 1175] : [660, 990]).forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.3);
      o.connect(g).connect(pan);
      o.start(t + i * 0.18);
      o.stop(t + i * 0.18 + 0.32);
    });
  }

  // ---- Repère d'objet retenu (épingle au sol / sur la table) ---------------
  function makePin() {
    const g = new THREE.Group();
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.036, 40), new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    g.add(dot, ring);
    g.userData.ring = ring;
    return g;
  }

  // Faisceau orbe → objet retrouvé.
  const beam = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineDashedMaterial({ color: 0xffd166, dashSize: 0.04, gapSize: 0.025, transparent: true, opacity: 0.9 }),
  );
  beam.visible = false;
  scene.add(beam);
  let highlight = null; // { item, until }

  // ---- Cartes --------------------------------------------------------------
  const fmt = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  };
  const clock = (ts) => new Date(ts).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });

  const KIND = {
    timer: { w: 0.3, h: 0.4, title: T("Minuteur", "Timer") },
    reminder: { w: 0.36, h: 0.26, title: T("Rappel", "Reminder") },
    note: { w: 0.34, h: 0.34, title: "Post-it" },
    object: { w: 0.3, h: 0.3, title: T("Objet", "Object") },
    device: { w: 0.32, h: 0.26, title: T("Domotique", "Home") },
  };

  function drawTimer(c, p, it) {
    const d = it.data, W = p.W, H = p.H - p.handleH;
    const left = d.pausedLeft ?? Math.max(0, d.endsAt - Date.now());
    const total = d.duration || 1;
    const done = !d.pausedLeft && left <= 0;
    const cx = W / 2, cy = 104, r = 80;
    c.lineWidth = 14;
    c.lineCap = "round";
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.strokeStyle = "rgba(255,255,255,0.12)"; c.stroke();
    c.beginPath(); c.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * left) / total);
    c.strokeStyle = done ? "#ff4d6d" : "#ff9e6b"; c.stroke();
    c.font = `600 ${left >= 3600000 ? 44 : 56}px ${font}`;
    c.fillStyle = done ? "#ff8095" : THEME.text; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(done ? T("Terminé", "Done") : fmt(left), cx, cy + 2);
    if (d.label) { c.font = `400 22px ${font}`; c.fillStyle = THEME.dim; c.fillText(d.label, cx, cy + 44); }
    const by = H - 78;
    if (done) {
      p.pill("t-ok", 30, by, W - 60, 64, T("Arrêter", "Stop"), () => remove(it.data.id), { active: true, color: "#ff4d6d" });
    } else {
      p.iconButton("t-pp", 24, by, 64, "", () => {
        if (d.pausedLeft != null) { d.endsAt = Date.now() + d.pausedLeft; d.pausedLeft = null; }
        else d.pausedLeft = Math.max(0, d.endsAt - Date.now());
        persist(); p.invalidate();
      }, { inContent: true, icon: d.pausedLeft != null ? "play" : "pause" });
      p.pill("t-add", 100, by, W - 124, 64, "+1 min", () => {
        if (d.pausedLeft != null) d.pausedLeft += 60000; else d.endsAt += 60000;
        d.duration += 60000; persist(); p.invalidate();
      });
    }
  }

  function drawReminder(c, p, it) {
    const d = it.data, W = p.W, H = p.H - p.handleH;
    const due = Date.now() >= d.dueAt;
    drawIcon(c, "bell", 26, 18, 40, due ? "#ffd166" : "#f4f5f8", 2);
    c.font = `600 30px ${font}`; c.fillStyle = due ? "#ffd166" : THEME.text; c.textAlign = "left"; c.textBaseline = "middle";
    c.fillText(due ? T("Maintenant", "Now") : clock(d.dueAt), 80, 38);
    c.font = `400 27px ${font}`; c.fillStyle = THEME.text; c.textBaseline = "top";
    wrap(c, d.text, W - 52).slice(0, 3).forEach((l, k) => c.fillText(l, 26, 76 + k * 36));
    if (due) p.pill("r-ok", 26, H - 74, W - 52, 60, T("C'est fait", "Done"), () => remove(d.id), { active: true, color: "#2f9e6e" });
  }

  function drawNote(c, p, it) {
    const W = p.W, H = p.H - p.handleH;
    // Papier jaune translucide.
    roundRect(c, 14, 6, W - 28, H - 20, 18);
    c.fillStyle = "rgba(255, 214, 102, 0.28)"; c.fill();
    c.font = `500 28px ${font}`; c.fillStyle = THEME.text; c.textAlign = "left"; c.textBaseline = "top";
    const lines = wrap(c, it.data.text || "", W - 70);
    lines.slice(0, 6).forEach((l, k) => c.fillText(l, 34, 22 + k * 36));
    if (lines.length > 6) c.fillText("…", 34, 22 + 6 * 36);
  }

  function drawObject(c, p, it) {
    const d = it.data, W = p.W;
    let y = 10;
    if (it.photo) {
      const img = it.photo, iw = W - 40, ih = 150;
      c.save(); roundRect(c, 20, y, iw, ih, 16); c.clip();
      const s = Math.max(iw / img.width, ih / img.height);
      c.drawImage(img, 20 + (iw - img.width * s) / 2, y + (ih - img.height * s) / 2, img.width * s, img.height * s);
      c.restore();
      y += ih + 12;
    } else {
      drawIcon(c, "key-round", W / 2 - 32, y + 20, 64, "#ffd166", 2);
      y += 104;
    }
    c.font = `600 30px ${font}`; c.fillStyle = THEME.text; c.textAlign = "center"; c.textBaseline = "top";
    c.fillText(d.label || T("Objet", "Object"), W / 2, y);
    c.font = `400 22px ${font}`; c.fillStyle = THEME.dim;
    c.fillText(new Date(d.created).toLocaleString(lang, { dateStyle: "short", timeStyle: "short" }), W / 2, y + 38);
  }

  function drawDevice(c, p, it) {
    const d = it.data, W = p.W, H = p.H - p.handleH;
    const st = deviceState.get(d.device);
    const on = st?.on;
    drawIcon(c, /lamp|light|ampoule|led/i.test(`${d.type} ${d.label}`) ? "lightbulb" : "power", 24, 14, 44, on ? "#ffd166" : "#f4f5f8", 2);
    c.font = `600 28px ${font}`; c.fillStyle = THEME.text; c.textAlign = "left"; c.textBaseline = "middle";
    let name = d.label || d.device;
    while (name.length > 3 && c.measureText(name).width > W - 110) name = name.slice(0, -2);
    c.fillText(name, 80, 36);
    c.font = `400 22px ${font}`; c.fillStyle = THEME.dim;
    c.fillText(st?.error ? T("injoignable", "unreachable") : st?.pending ? "…" : on == null ? "" : on ? T("allumé", "on") : T("éteint", "off"), 80, 66);
    const bw = (W - 70) / 2;
    p.pill("d-on", 26, H - 82, bw, 66, T("Allumer", "On"), () => deviceCmd(d, "on"), { active: on === true, color: "#e3a21a" });
    p.pill("d-off", 44 + bw, H - 82, bw, 66, T("Éteindre", "Off"), () => deviceCmd(d, "off"), { active: on === false });
  }

  const DRAW = { timer: drawTimer, reminder: drawReminder, note: drawNote, object: drawObject, device: drawDevice };

  /// Crée (ou restaure) un objet de l'espace. `at` : point monde où le poser.
  function create(data, { restore: restoring = false, at = null } = {}) {
    data.id = data.id || uid();
    data.created = data.created || Date.now();
    const k = KIND[data.kind];
    if (!k) return null;
    const it = { data, panel: null, pin: null, photo: null };
    const title = data.kind === "device" ? (data.label || k.title) : k.title;
    const panel = new Panel({
      width: k.w, height: k.h, title, closable: true, radius: 36, resizable: false,
      onClose: () => remove(data.id),
      draw: (c, p) => DRAW[data.kind](c, p, it),
    });
    const key = "space:" + data.id;
    addPanel(panel, new THREE.Vector3(), 0, false, key);
    it.panel = panel;
    if (data.photo) {
      const img = new Image();
      img.onload = () => { it.photo = img; panel.invalidate(); };
      img.src = data.photo;
    }
    if (data.kind === "object" && data.point) {
      it.pin = makePin();
      it.pin.position.fromArray(data.point);
      world.add(it.pin);
    }
    items.set(data.id, it);
    if (restoring && Array.isArray(data.pos)) {
      panel.object.position.fromArray(data.pos);
      if (Array.isArray(data.q)) panel.object.quaternion.fromArray(data.q);
    } else {
      const p = at || gazePoint();
      // La carte se pose un peu au-dessus du point visé, tournée vers soi.
      setWorldPosition(panel.object, p.clone().add(new THREE.Vector3(0, data.kind === "object" ? 0.2 : 0.12, 0)));
      faceHead(panel.object);
      ctx.anchor(key, panel.object);
    }
    panel.open();
    persist();
    return it;
  }

  function remove(id) {
    const it = items.get(id);
    if (!it) return;
    items.delete(id);
    if (it.pin) world.remove(it.pin);
    if (highlight?.item === it) { highlight = null; beam.visible = false; }
    removePanel(it.panel);
    persist();
    hub.invalidate();
  }

  // ---- Actions ---------------------------------------------------------------
  function addTimer(ms, label = "") {
    const it = create({ kind: "timer", duration: ms, endsAt: Date.now() + ms, label });
    earcon(true);
    toast(T(`Minuteur de ${fmt(ms)} lancé`, `${fmt(ms)} timer started`));
    return it;
  }

  async function addReminder(text, ms) {
    const dueAt = Date.now() + ms;
    create({ kind: "reminder", text, dueAt });
    // Le bureau le sait aussi : il notifiera le téléphone, même casque retiré.
    try { await api("/capture", { method: "POST", body: JSON.stringify({ kind: "reminder", text, due_in_ms: ms }) }); } catch {}
    toast(T(`Rappel à ${clock(dueAt)}`, `Reminder at ${clock(dueAt)}`));
  }

  async function addNote(text) {
    create({ kind: "note", text });
    // Copie dans l'app Notes (App Intent) ; à défaut, dans la messagerie.
    const title = text.split(/[.!?\n]/)[0].slice(0, 60) || "Post-it";
    const r = await runIntent("notes", "create_note", { title, body: text }).catch((e) => ({ error: String(e) }));
    if (r?.error) { try { await api("/capture", { method: "POST", body: JSON.stringify({ kind: "note", text }) }); } catch {} }
    toast(T("Post-it collé", "Sticky note placed"));
  }

  async function rememberObject(label) {
    const point = ctx.lookHit() || gazePoint(0.8);
    let photo = null;
    try {
      const c = await captureFrame();
      const s = Math.min(1, 360 / Math.max(c.width, c.height));
      const t = document.createElement("canvas");
      t.width = Math.round(c.width * s); t.height = Math.round(c.height * s);
      t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
      photo = t.toDataURL("image/jpeg", 0.7);
    } catch { /* pas de caméra : le repère suffit */ }
    const localPoint = world.worldToLocal(point.clone()).toArray().map((v) => +v.toFixed(3));
    const it = create({ kind: "object", label, point: localPoint, photo }, { at: point });
    toast(T(`Je me souviens : ${label}`, `Remembered: ${label}`));
    say(T(`D'accord, je me souviens où sont ${label}.`, `Got it, I'll remember where ${label} is.`));
    return it;
  }

  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\b(mes|ma|mon|les|la|le|l'|my|the)\b/g, "").replace(/\s+/g, " ").trim();

  function findObject(query) {
    const q = norm(query);
    let best = null, score = 0;
    for (const it of items.values()) {
      if (it.data.kind !== "object") continue;
      const l = norm(it.data.label);
      const s = l === q ? 3 : l.includes(q) || q.includes(l) ? 2 : q.split(" ").some((w) => w.length > 2 && l.includes(w)) ? 1 : 0;
      if (s > score) { score = s; best = it; }
    }
    return best;
  }

  /// Faisceau vers l'objet, phrase de direction (« à ta gauche, à 2 m »).
  function showObject(it) {
    highlight = { item: it, until: performance.now() + 10000 };
    beam.visible = true;
    const target = it.pin ? it.pin.getWorldPosition(new THREE.Vector3()) : it.panel.object.getWorldPosition(new THREE.Vector3());
    const { pos, quat } = headPose();
    const rel = target.clone().sub(pos).applyQuaternion(quat.clone().invert());
    const dist = Math.hypot(rel.x, rel.z);
    const ang = Math.atan2(rel.x, -rel.z) * 180 / Math.PI; // 0 = devant, + = droite
    const where = Math.abs(ang) < 25 ? T("devant toi", "in front of you")
      : Math.abs(ang) > 135 ? T("derrière toi", "behind you")
      : ang > 0 ? T("à ta droite", "to your right") : T("à ta gauche", "to your left");
    const m = dist < 1 ? T("tout près", "very close") : T(`à environ ${Math.round(dist)} m`, `about ${Math.round(dist)} m away`);
    const when = new Date(it.data.created).toLocaleString(lang, { weekday: "long", hour: "2-digit", minute: "2-digit" });
    say(T(`${it.data.label} : ${where}, ${m}. Posés ${when}.`, `${it.data.label}: ${where}, ${m}. Left ${when}.`));
    it.panel.open();
    ctx.lookAt?.(target);
    // L'orbe va jusqu'aux clés, s'y arrête, puis revient.
    ctx.flyOrbTo?.(target);
  }

  // ---- Domotique ---------------------------------------------------------------
  let domoSeq = 0;
  function deviceCmd(d, action) {
    deviceState.set(d.device, { ...(deviceState.get(d.device) || {}), pending: true });
    send({ type: "xr-domo-cmd", id: ++domoSeq, device: d.device, component: d.component || null, action });
    // Optimiste : l'état s'affiche tout de suite, corrigé par la réponse.
    deviceState.set(d.device, { on: action === "on" ? true : action === "off" ? false : !deviceState.get(d.device)?.on, pending: true });
    items.forEach((it) => { if (it.data.device === d.device) it.panel.invalidate(); });
  }
  function placeDevice(dev) {
    const existing = [...items.values()].find((it) => it.data.kind === "device" && it.data.device === (dev.id || dev.name));
    if (existing) remove(existing.data.id);
    const comp = Array.isArray(dev.components) && dev.components.length === 1 ? dev.components[0]?.key : null;
    create({ kind: "device", device: dev.id || dev.name, label: dev.name, type: dev.type || "", component: comp }, { at: ctx.lookHit() || gazePoint() });
    send({ type: "xr-domo-state", device: dev.id || dev.name });
    toast(T(`Commande de « ${dev.name} » posée ici`, `“${dev.name}” control placed here`));
  }
  /// Commande d'objet la plus proche de l'axe du regard (« éteins ÇA »).
  function gazedDevice() {
    const { pos, quat } = headPose();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    let best = null, bestAng = 0.45; // ~25°
    for (const it of items.values()) {
      if (it.data.kind !== "device") continue;
      const dir = it.panel.object.getWorldPosition(new THREE.Vector3()).sub(pos).normalize();
      const a = fwd.angleTo(dir);
      if (a < bestAng) { bestAng = a; best = it; }
    }
    return best;
  }

  // ---- Commandes vocales locales --------------------------------------------
  function handleUtterance(text) {
    const t = text.trim().replace(/[.!]+$/, "");
    let m;
    // Minuteur : « mets un minuteur de 10 minutes », « timer 5 min »
    if ((m = t.match(/(?:minuteur|timer|compte à rebours)\s*(?:de|pour|for|of)?\s*([\d.,]+|[a-zé-]+)\s*(secondes?|sec|s|minutes?|min|mn|heures?|h|hours?)\b/i))) {
      const n = toNum(m[1]);
      if (n > 0) { addTimer(Math.round(n * unitMs(m[2])), ""); return true; }
    }
    // Rappel : « rappelle-moi de X dans 20 minutes » / « remind me to X in 1 hour »
    if ((m = t.match(/(?:rappelle[- ]moi|remind me)\s+(?:de\s+|d'|to\s+)?(.+?)\s+(?:dans|in)\s+([\d.,]+|[a-zé-]+)\s*(secondes?|minutes?|min|heures?|h|hours?)\b/i))) {
      const n = toNum(m[2]);
      if (n > 0) { addReminder(m[1], Math.round(n * unitMs(m[3]))); return true; }
    }
    // Post-it : « note ici : acheter du lait », « post-it : … »
    if ((m = t.match(/^(?:(?:mets|colle|ajoute)\s+)?(?:une\s+)?(?:note|post-?it|sticky note)(?:\s+ici|\s+here)?\s*[:,]?\s+(.{3,})$/i))) {
      addNote(m[1]); return true;
    }
    // Objet : « souviens-toi où j'ai posé mes clés »
    if ((m = t.match(/(?:souviens[- ]toi|rappelle[- ]toi|retiens|remember)\s+(?:où|where)\s+(?:j'ai|je\s+(?:mets|pose|range)|i\s+(?:put|left|placed))\s*(?:posé|mis|rangé|laissé)?\s+(.+)$/i))) {
      rememberObject(m[1].trim()); return true;
    }
    // Retrouver : « où sont mes clés ? », « where are my keys »
    if ((m = t.match(/^(?:où\s+(?:sont|est|j'ai\s+(?:mis|posé|rangé)|as[- ]tu\s+vu)|where\s+(?:are|is|did\s+i\s+(?:put|leave)))\s+(.+?)\s*\??$/i))) {
      const it = findObject(m[1]);
      if (it) { showObject(it); return true; }
      return false; // inconnu ici : la question part au modèle
    }
    // Domotique : « éteins ça », « allume la lampe du salon »
    if ((m = t.match(/^(allume|éteins|eteins|ouvre|ferme|turn\s+on|turn\s+off|switch\s+on|switch\s+off)\s+(.+)$/i))) {
      const verb = m[1].toLowerCase();
      const action = /allume|ouvre|on$/.test(verb) ? "on" : "off";
      const target = m[2].trim();
      if (/^(ça|ca|ceci|cela|celle-ci|celui-ci|la|le|it|this|that)$/i.test(target)) {
        const it = gazedDevice();
        if (!it) { toast(T("Regardez la commande de l'objet à piloter", "Look at the device control first")); return true; }
        deviceCmd(it.data, action);
        return true;
      }
      if (devices.length) {
        const n = norm(target);
        const dev = devices.find((d) => norm(d.name) === n) || devices.find((d) => norm(d.name).includes(n) || n.includes(norm(d.name)));
        if (dev) { deviceCmd({ device: dev.id || dev.name, component: null }, action); toast(`${dev.name} ← ${action}`); return true; }
      }
      return false; // le modèle (outils domotique du bureau) prendra le relais
    }
    return false;
  }

  // ---- Panneau « Espace » -------------------------------------------------------
  const hubState = { domoOpen: false };
  const hub = addPanel(new Panel({
    width: 0.66, height: 1.0, title: T("Espace", "Space"), closable: true, onClose: () => ctx.onPanelsChanged(),
    draw(c, p) {
      const W = p.W, x = 30, w = W - 60;
      let y = 12;
      const label = (t) => { c.font = `600 23px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "left"; c.textBaseline = "middle"; c.fillText(t.toUpperCase(), x, y + 12); y += 34; };
      label(T("Minuteur ici", "Timer here"));
      const mins = [1, 5, 10, 15, 30];
      const bw = (w - 4 * 12) / 5;
      mins.forEach((mn, i) => p.pill("tm" + mn, x + i * (bw + 12), y, bw, 64, `${mn} min`, () => addTimer(mn * 60000)));
      y += 84;
      label(T("Poser", "Place"));
      const hw = (w - 12) / 2;
      p.pill("note", x, y, hw, 70, T("Post-it dicté", "Dictated note"), () => dictate(T("Dictez le post-it…", "Dictate the note…"), (txt) => txt && addNote(txt)));
      p.pill("obj", x + hw + 12, y, hw, 70, T("Retenir un objet", "Remember object"), () => dictate(T("Quel objet ?", "Which object?"), (txt) => txt && rememberObject(txt.replace(/[.!?]+$/, ""))));
      y += 90;
      const objs = [...items.values()].filter((it) => it.data.kind === "object");
      if (objs.length) {
        label(T("Objets retenus", "Remembered objects"));
        for (const it of objs.slice(0, 3)) {
          roundRect(c, x, y, w, 64, 20);
          c.fillStyle = "rgba(255,255,255,0.06)"; c.fill();
          drawIcon(c, "key-round", x + 16, y + 14, 36, "#ffd166", 2);
          c.font = `500 26px ${font}`; c.fillStyle = THEME.text; c.textAlign = "left"; c.textBaseline = "middle";
          c.fillText(it.data.label, x + 66, y + 32);
          p.pill("show:" + it.data.id, x + w - 250, y + 8, 150, 48, T("Montrer", "Show"), () => showObject(it));
          p.iconButton("del:" + it.data.id, x + w - 88, y + 6, 52, "", () => remove(it.data.id), { inContent: true, icon: "trash-2" });
          y += 74;
        }
        y += 6;
      }
      label(T("Domotique", "Home devices"));
      if (!devices.length) {
        c.font = `400 24px ${font}`; c.fillStyle = THEME.dim; c.textAlign = "left";
        c.fillText(T("Aucun objet (app Domotique)", "No device (Home app)"), x, y + 20);
        y += 50;
      }
      for (const dev of devices.slice(0, Math.max(0, Math.floor((p.H - p.handleH - y - 10) / 74)))) {
        roundRect(c, x, y, w, 64, 20);
        c.fillStyle = "rgba(255,255,255,0.06)"; c.fill();
        drawIcon(c, /lamp|light|led/i.test(`${dev.type} ${dev.name}`) ? "lightbulb" : "power", x + 16, y + 14, 36, "#f4f5f8", 2);
        c.font = `500 26px ${font}`; c.fillStyle = THEME.text; c.textAlign = "left"; c.textBaseline = "middle";
        c.fillText(`${dev.name}${dev.room ? " · " + dev.room : ""}`.slice(0, 30), x + 66, y + 32);
        p.pill("place:" + (dev.id || dev.name), x + w - 190, y + 8, 180, 48, T("Poser ici", "Place here"), () => placeDevice(dev));
        y += 74;
      }
    },
  }), new THREE.Vector3(0.75, 0.05, -1.0), -0.6, false, "space-hub");
  hub.object.visible = false;

  // ---- Messages ----------------------------------------------------------------
  function onMessage(msg) {
    switch (msg.type) {
      case "xr-domo": devices = msg.devices || []; hub.invalidate(); return true;
      case "xr-domo-result": {
        const cur = deviceState.get(msg.device) || {};
        deviceState.set(msg.device, msg.ok ? { on: cur.on } : { error: msg.error });
        if (!msg.ok) toast(T("Commande refusée", "Command failed"));
        items.forEach((it) => { if (it.data.device === msg.device) it.panel.invalidate(); });
        return true;
      }
      case "xr-domo-state": {
        let on = null;
        try {
          const s = JSON.parse(msg.state || "{}");
          const v = s.on ?? s.state ?? s.value ?? s.power;
          on = typeof v === "boolean" ? v : typeof v === "number" ? v > 0 : typeof v === "string" ? /^(on|1|true)$/i.test(v) : null;
        } catch { /* état libre */ }
        deviceState.set(msg.device, msg.error ? { error: msg.error } : { on });
        items.forEach((it) => { if (it.data.device === msg.device) it.panel.invalidate(); });
        return true;
      }
    }
    return false;
  }

  // ---- Chaque image -------------------------------------------------------------
  let lastSecond = 0;
  function tick(now) {
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== lastSecond) {
      lastSecond = sec;
      for (const it of items.values()) {
        const d = it.data;
        if (d.kind === "timer") {
          it.panel.invalidate();
          if (d.pausedLeft == null && Date.now() >= d.endsAt) {
            // Alarme toutes les 2 s, jusqu'à ce qu'on l'arrête.
            if (!d.lastRing || Date.now() - d.lastRing > 2000) {
              d.lastRing = Date.now();
              chimeAt(it.panel.object, true);
              if (!d.announced) { d.announced = true; toast(T("Minuteur terminé", "Timer done"), 4000); }
            }
          }
        } else if (d.kind === "reminder" && !d.fired && Date.now() >= d.dueAt) {
          d.fired = true;
          chimeAt(it.panel.object);
          say(d.text);
          it.panel.invalidate();
          persist();
        }
      }
    }
    // Épingles : l'anneau respire ; celle qu'on cherche pulse fort.
    const t = now / 1000;
    for (const it of items.values()) {
      if (!it.pin) continue;
      const hot = highlight?.item === it;
      const s = hot ? 1 + 0.6 * Math.abs(Math.sin(t * 5)) : 1 + 0.08 * Math.sin(t * 2);
      it.pin.userData.ring.scale.setScalar(s);
    }
    if (highlight) {
      if (now > highlight.until) { highlight = null; beam.visible = false; }
      else {
        const a = orbWorld();
        const b = (highlight.item.pin || highlight.item.panel.object).getWorldPosition(new THREE.Vector3());
        const pos = beam.geometry.attributes.position;
        pos.setXYZ(0, a.x, a.y, a.z); pos.setXYZ(1, b.x, b.y, b.z); pos.needsUpdate = true;
        beam.computeLineDistances();
      }
    }
  }

  restore();

  return {
    hub, items, persist, tick, onMessage, handleUtterance, addTimer, addNote, rememberObject, findObject, showObject,
    open: () => { send({ type: "xr-domo-list" }); ctx.openNear(hub); },
  };
}
