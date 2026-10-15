// Lumen XR — des OBJETS physiques dans la pièce.
//
// Ce qui était une liste dans un panneau devient une chose qu'on prend en main :
//
//   • DOSSIERS  — chaque sandbox est un dossier 3D (couverture, onglet,
//                 étiquette). Un appui l'ouvre : ses fichiers en sortent en
//                 éventail, comme des feuilles. Les sous-dossiers aussi.
//   • FICHIERS  — des feuilles de papier (bandeau de couleur selon le type).
//                 On les attrape, on les lance (elles tombent sur la table ou
//                 au sol, puis reviennent), on les lâche :
//                   – sur l'orbe   → Lumen les « avale » et demande quoi en faire ;
//                   – sur un agent → l'agent les attrape et prend la tâche dictée.
//                 Un appui : la feuille vient devant les yeux, en grand, avec
//                 le début du texte.
//   • AGENTS    — l'équipe en figurines debout sur la table (les personnages
//                 du bureau). Elles s'animent quand l'agent travaille, sautent
//                 à la fin, et PARLENT depuis leur place, avec leur voix. Une
//                 approbation en attente : bulle ✓ ✗ au-dessus de la tête, ou
//                 pouce levé.
//
// Tout est tenu par une petite physique maison (gravité, rebond, frottement,
// lancer) posée sur les surfaces détectées (tables, sol), et ponctué de sons
// spatialisés et de courts commentaires de Lumen.

import * as THREE from "/lib/three.module.js";
import { avatarLayers, avatarColor, talkingFaceParts } from "/lib/agent-avatar.js";
import { slab, createSculptedIcon, contactShadow, labelMesh, disposeDesign } from "/xr-design.js";
import { humanStep } from "/lib/agent-steps.js";

const LS_KEY = "xrProps";
const G = 9.8;
const FOLDER_COLORS = [0xf2b84b, 0x5aa7ff, 0x62d39a, 0xff7eb6, 0xb58cff, 0xff9f5a];
const TYPE_STYLE = [
  { re: /\.pdf$/i, color: "#e5484d", label: "PDF", icon: "file-text" },
  { re: /\.(png|jpe?g|gif|webp|heic|svg)$/i, color: "#30a46c", label: "IMG", icon: "image" },
  { re: /\.(docx?|odt|rtf|pages)$/i, color: "#3e63dd", label: "DOC", icon: "file-text" },
  { re: /\.(xlsx?|ods|csv|numbers|lumensheet)$/i, color: "#29a383", label: "TAB", icon: "table" },
  { re: /\.(pptx?|odp|key)$/i, color: "#f76b15", label: "PRÉS", icon: "presentation" },
  { re: /\.(md|txt|lumennote)$/i, color: "#8b8d98", label: "TXT", icon: "notebook-pen" },
  { re: /\.(js|ts|py|rs|swift|html|css|json|c|cpp|java|go)$/i, color: "#8e4ec6", label: "CODE", icon: "code" },
];
const styleOf = (name) => TYPE_STYLE.find((s) => s.re.test(name)) || { color: "#6e6e78", label: "FICH", icon: "file" };
const hashColor = (s) => FOLDER_COLORS[[...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % FOLDER_COLORS.length];

export function createProps(ctx) {
  const { scene, world, spatial, headPose, orbWorld, T, toast, send, api, roundRect, wrap, drawIcon, THEME } = ctx;
  const font = THEME.font;
  const root = new THREE.Group();
  world.add(root);
  const all = [];                 // tous les objets
  const pickables = [];           // maillages visés par les rayons
  let shown = false;
  let seq = 0;
  const _v = new THREE.Vector3(), _w = new THREE.Vector3();

  // ---------------------------------------------------------------- Outils

  function canvasTex(w, h, draw) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    draw(g, w, h);
    // Icônes chargées en différé : second passage une fois prêtes.
    setTimeout(() => { g.clearRect(0, 0, w, h); draw(g, w, h); tex.needsUpdate = true; }, 400);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return { tex, canvas: c, g, redraw(fn) { g.clearRect(0, 0, w, h); fn(g, w, h); tex.needsUpdate = true; } };
  }
  /// Hauteur (repère `world`) de la surface sous un point local : table détectée, sinon le sol.
  function groundAt(local) {
    world.updateMatrixWorld(true);
    const wp = world.localToWorld(local.clone());
    return spatial.surfaceBelow(wp) - world.position.y;
  }
  const toWorld = (local) => { world.updateMatrixWorld(true); return world.localToWorld(local.clone()); };
  const toLocal = (wp) => { world.updateMatrixWorld(true); return world.worldToLocal(wp.clone()); };
  function headLocal() { return toLocal(headPose().pos); }
  /// Oriente un objet vers l'utilisateur (axe vertical seulement).
  function faceUser(obj, k = 1) {
    const h = headLocal();
    const yaw = Math.atan2(h.x - obj.position.x, h.z - obj.position.z);
    let d = yaw - obj.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    obj.rotation.y += d * k;
  }

  // ---------------------------------------------------------------- Sons
  // Synthétisés et SPATIALISÉS à la position de l'objet : on entend la feuille
  // tomber là où elle tombe.
  function sfx(kind, at, strength = 1) {
    const ac = ctx.audio?.();
    if (!ac) return;
    const t = ac.currentTime;
    const p = toWorld(at);
    const pan = new PannerNode(ac, { panningModel: "HRTF", distanceModel: "inverse", refDistance: 0.6, positionX: p.x, positionY: p.y, positionZ: p.z });
    const out = ac.createGain();
    out.connect(pan).connect(ac.destination);
    const noise = (dur) => {
      const b = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const s = ac.createBufferSource(); s.buffer = b; return s;
    };
    const tone = (f0, f1, dur, type = "sine", vol = 0.15) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(out); o.start(t); o.stop(t + dur + 0.02);
    };
    const filtered = (dur, type, f, vol, q = 0.8) => {
      const s = noise(dur), fl = ac.createBiquadFilter(), g = ac.createGain();
      fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(fl).connect(g).connect(out); s.start(t);
    };
    if (kind === "grab") tone(1300, 900, 0.05, "sine", 0.09);
    else if (kind === "hover") tone(2400, 2200, 0.025, "sine", 0.025);
    else if (kind === "land") filtered(0.12, "lowpass", 260, 0.35 * Math.min(1, strength), 0.7);
    else if (kind === "paper") filtered(0.22, "bandpass", 3200, 0.12, 0.6);
    else if (kind === "open") { filtered(0.3, "bandpass", 2600, 0.16, 0.5); tone(420, 640, 0.12, "triangle", 0.05); }
    else if (kind === "absorb") { tone(520, 1040, 0.22, "sine", 0.12); tone(780, 1560, 0.26, "sine", 0.06); }
    else if (kind === "catch") { tone(660, 990, 0.1, "triangle", 0.1); filtered(0.08, "lowpass", 400, 0.15); }
    else if (kind === "whoosh") filtered(0.35, "bandpass", 900, 0.12 * Math.min(1.5, strength), 0.4);
    else if (kind === "pop") tone(300, 900, 0.09, "sine", 0.12);
    else if (kind === "yes") { tone(660, 660, 0.09, "sine", 0.1); setTimeout(() => sfx("pop", at), 90); }
  }

  // ---------------------------------------------------------------- Commentaires
  // Lumen réagit à ce qu'on fait — brièvement, jamais par-dessus une réponse,
  // pas plus d'une phrase toutes les 3 s.
  let lastComment = 0;
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  function comment(fr, en, { force = false, voice = "", at = null } = {}) {
    const now = performance.now();
    if (!force && (now - lastComment < 3000 || ctx.isSpeaking?.())) return;
    lastComment = now;
    const text = T(Array.isArray(fr) ? pick(fr) : fr, Array.isArray(en) ? pick(en) : en);
    if (at) ctx.speakAt?.(text, { voice, pos: at }); else ctx.say?.(text);
  }

  // ---------------------------------------------------------------- Objets
  /// `prop` : { id, kind, obj (Group), hit (Mesh), state, vel, spin, home, data }
  function makeProp(kind, obj, hit, data = {}) {
    const prop = { id: ++seq, kind, obj, hit, data, state: "float", vel: new THREE.Vector3(), spin: new THREE.Vector3(), home: null, homeQ: null, hover: 0, scale: 1, born: performance.now() };
    obj.visible=shown;
    hit.userData.prop = prop;
    root.add(obj);
    all.push(prop);
    pickables.push(hit);
    return prop;
  }
  function dispose(prop) {
    if(prop.disposed)return;
    root.remove(prop.obj);
    const i = all.indexOf(prop); if (i >= 0) all.splice(i, 1);
    const descendants=new Set();prop.obj.traverse(o=>descendants.add(o));
    for(let j=pickables.length-1;j>=0;j--)if(descendants.has(pickables[j]))pickables.splice(j,1);
    prop.disposed = true;
    disposeDesign(prop.obj);
    prop.data.inspectedTexture?.tex?.dispose();
  }

  // ---- Dossiers ------------------------------------------------------------
  function folderLabel(g, w, h, name, count, color) {
    roundRect(g, 8, 8, w - 16, h - 16, 24);
    g.fillStyle = "rgba(18,29,57,0.88)"; g.fill();
    g.fillStyle = "#f4f8ff"; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `600 ${Math.round(h * 0.21)}px ${font}`;
    const lines = wrap(g, name, w * 0.88).slice(0, 2);
    lines.forEach((l, k) => g.fillText(l, w / 2, h * (lines.length > 1 ? 0.30 + k * 0.25 : 0.46)));
    if (count != null) {
      g.font = `500 ${Math.round(h * 0.085)}px ${font}`; g.fillStyle = "rgba(235,245,255,0.78)";
      g.fillText(T(`${count} élément${count > 1 ? "s" : ""}`, `${count} item${count > 1 ? "s" : ""}`), w / 2, h * 0.86);
    }
  }
  function createFolder(sb, pos) {
    const color = hashColor(sb.id);
    const group = new THREE.Group();
    const back = slab(.17, .125, .008, color); back.position.set(0,.067,-.013);
    const tab = slab(.055,.018,.008,color); tab.position.set(-.048,.135,-.013);
    const papers = new THREE.Group();
    for(let i=0;i<3;i++) {
      const sheet = slab(.145,.108,.0025,0xf0f7ff);
      sheet.position.set(i*.002,.067+i*.003,-.007+i*.006); sheet.rotation.z=(i-1)*.025; papers.add(sheet);
    }
    const hinge = new THREE.Group();
    const front = slab(.178,.108,.008,color,{glass:true}); front.position.set(0,.057,.015); hinge.add(front);
    const label = canvasTex(512,180,(g,w,h)=>folderLabel(g,w,h,sb.name,null,color));
    const name = new THREE.Mesh(new THREE.PlaneGeometry(.126,.044),new THREE.MeshBasicMaterial({map:label.tex,transparent:true,depthWrite:false}));
    name.position.set(0,.050,.024); hinge.add(name);
    const accent = slab(.066,.002,.002,0xc8e8ff); accent.position.set(0,.092,.021); hinge.add(accent);
    const visual=new THREE.Group();visual.add(back,tab,papers,hinge);group.add(visual);
    const shadow = contactShadow(.25,.12); shadow.position.set(0,.001,0); group.add(shadow);
    // Zone de visée un peu plus large que le dossier (plus facile à attraper).
    const hit = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.06), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.set(0, 0.07, 0);
    group.add(hit);
    group.position.copy(pos);
    const prop = makeProp("folder", group, hit, { sandbox: sb, label, color, hinge, papers, shadow, visual, path: "", open: false, entries: null, page: 0, fan: [] });
    prop.halfH = 0;
    faceUser(group);
    return prop;
  }

  // ---- Fichiers ------------------------------------------------------------
  function paperTexture(entry, big = false, preview = "", image = null) {
    const st = entry.is_dir ? { color: "#d9a43a", label: T("DOSSIER", "FOLDER"), icon: "folder" } : styleOf(entry.name);
    const W = big ? 768 : 384, H = Math.round(W * 1.3);
    return canvasTex(W, H, (g, w, h) => {
      g.fillStyle = "#fbfaf6"; g.fillRect(0, 0, w, h);
      g.fillStyle = st.color; g.fillRect(0, 0, w, h * 0.17);
      drawIcon(g, st.icon, w * 0.07, h * 0.035, h * 0.1, "#ffffff", 2.2);
      g.fillStyle = "#ffffff"; g.font = `700 ${Math.round(h * 0.06)}px ${font}`; g.textAlign = "right"; g.textBaseline = "middle";
      g.fillText(st.label, w * 0.93, h * 0.085);
      g.fillStyle = "#1b1c22"; g.textAlign = "left"; g.textBaseline = "top";
      g.font = `700 ${Math.round(h * (big ? 0.042 : 0.072))}px ${font}`;
      let y = h * 0.22;
      for (const l of wrap(g, entry.name, w * 0.86).slice(0, big ? 2 : 4)) { g.fillText(l, w * 0.07, y); y += h * (big ? 0.052 : 0.085); }
      if (entry.size && !entry.is_dir) {
        g.font = `500 ${Math.round(h * (big ? 0.028 : 0.05))}px ${font}`; g.fillStyle = "#7a7c86";
        const kb = entry.size / 1024;
        g.fillText(kb > 1024 ? `${(kb / 1024).toFixed(1)} Mo` : `${Math.max(1, Math.round(kb))} Ko`, w * 0.07, y + h * 0.01);
        y += h * (big ? 0.05 : 0.07);
      }
      if (big && image) {
        const ratio = Math.min(w*.86/image.naturalWidth, (h-y-h*.08)/image.naturalHeight);
        g.drawImage(image,w*.07+(w*.86-image.naturalWidth*ratio)/2,y+h*.04,image.naturalWidth*ratio,image.naturalHeight*ratio);
      } else if (big) {
        g.font = `400 ${Math.round(h * 0.026)}px ${font}`; g.fillStyle = "#3a3c46";
        const text = preview || T("Lecture…", "Reading…");
        let yy = y + h * 0.02;
        for (const l of wrap(g, text, w * 0.86)) { if (yy > h * 0.95) break; g.fillText(l, w * 0.07, yy); yy += h * 0.036; }
      } else {
        if(image) {
          const iw=w*.86, ih=h*.38, ratio=Math.min(iw/image.naturalWidth,ih/image.naturalHeight);
          g.drawImage(image,w*.07+(iw-image.naturalWidth*ratio)/2,h*.54+(ih-image.naturalHeight*ratio)/2,image.naturalWidth*ratio,image.naturalHeight*ratio);
          return;
        }
        if(preview) {
          g.font=`400 ${Math.round(h*.029)}px ${font}`; g.fillStyle="#3e4b66";
          wrap(g,preview,w*.86).slice(0,10).forEach((line,k)=>g.fillText(line,w*.07,h*(.56+k*.036)));
          return;
        }
        // Placeholder until the real excerpt arrives.
        g.fillStyle = "#e3e1da";
        for (let k = 0; k < 6; k++) g.fillRect(w * 0.07, h * (0.62 + k * 0.055), w * (k % 3 === 2 ? 0.5 : 0.86), h * 0.018);
      }
    });
  }
  /// Bouton de navigation de l'éventail : pastille de verre sombre + flèche
  /// blanche (Retour ↑, Précédents ←, Suivants →), comme les flèches du dock.
  function createNavArrow(entry, folder, at) {
    const group = new THREE.Group();
    const t = canvasTex(160, 160, (g, w, h) => {
      g.beginPath(); g.arc(w / 2, h / 2, 74, 0, Math.PI * 2);
      g.fillStyle = "rgba(26,28,38,0.92)"; g.fill(); g.lineWidth = 4; g.strokeStyle = "rgba(255,255,255,0.35)"; g.stroke();
      g.save(); g.translate(w / 2, h / 2); g.rotate({ right: 0, left: Math.PI, up: -Math.PI / 2 }[entry.arrow] || 0);
      g.strokeStyle = "#f4f5f8"; g.lineWidth = 14; g.lineCap = "round"; g.lineJoin = "round";
      g.beginPath(); g.moveTo(-14, -30); g.lineTo(18, 0); g.lineTo(-14, 30); g.stroke(); g.restore();
    });
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(.06, .06), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true, depthWrite: false }));
    group.add(disc);
    const label = labelMesh(entry.name, .08); label.position.set(0, -.042, .001); group.add(label);
    group.position.copy(at);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(.07, .075, .012), new THREE.MeshBasicMaterial({ visible: false })); group.add(hit);
    const prop = makeProp("subfolder", group, hit, { entry, folder, tex: t, face: disc.material });
    prop.halfH = 0.035;
    return prop;
  }
  function createFile(entry, folder, at) {
    if (entry.arrow) return createNavArrow(entry, folder, at);
    const group = new THREE.Group();
    const tex = paperTexture(entry);
    const face = new THREE.MeshStandardMaterial({map:tex.tex,roughness:.65,emissive:0xffffff,emissiveIntensity:0});
    const card = slab(.074,.096,.004,0xeaf2ff); group.add(card);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(.071,.093),face); mesh.position.z=.0027; group.add(mesh);
    if(entry.is_dir) {
      const icon = createSculptedIcon("folder",{color:0xffbe69}); icon.scale.setScalar(.039); icon.position.set(0,-.016,.009); group.add(icon);
    } else {
      const accent=slab(.015,.003,.003,styleOf(entry.name).color); accent.position.set(.024,-.043,.005); group.add(accent);
    }
    group.position.copy(at);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(.079,.101,.012),new THREE.MeshBasicMaterial({visible:false})); group.add(hit);
    const prop = makeProp(entry.is_dir ? "subfolder" : "file",group,hit,{entry,folder,face,tex});
    if(!entry.is_dir) queuePreview(prop);
    prop.halfH = 0.048;
    return prop;
  }

  const previewQueue=[], previewCache=new Map(); let previewActive=0;
  function queuePreview(prop) { prop.data.previewReady=new Promise(resolve=>prop.data.previewDone=resolve);previewQueue.push(prop); pumpPreviews(); }
  function pumpPreviews() {
    const limit=ctx.settings?.perf ? 1 : 2;
    while(previewActive<limit && previewQueue.length) {
      const prop=previewQueue.shift(); if(prop.disposed){prop.data.previewDone?.();continue;}
      previewActive++;
      loadPreview(prop).finally(()=>{prop.data.previewDone?.();previewActive--; pumpPreviews();});
    }
  }
  async function loadPreview(prop) {
    const e=prop.data.entry, sb=prop.data.folder.data.sandbox;
    const key=`${sb.id}:${e.path}`, imageType=styleOf(e.name).label==="IMG";
    try {
      let value=previewCache.get(key);
      if(value===undefined) {
        if(imageType && ctx.mediaUrl && (e.size || 0)<8*1024*1024 && !/\.svg$/i.test(e.name)) {
          value=await new Promise(resolve=>{const image=new Image(); let timer=setTimeout(()=>resolve(null),6000); image.onload=()=>{clearTimeout(timer);if(image.naturalWidth>256 || image.naturalHeight>256){const canvas=document.createElement("canvas"),ratio=Math.min(256/image.naturalWidth,256/image.naturalHeight);canvas.width=Math.round(image.naturalWidth*ratio);canvas.height=Math.round(image.naturalHeight*ratio);canvas.getContext("2d").drawImage(image,0,0,canvas.width,canvas.height);canvas.naturalWidth=canvas.width;canvas.naturalHeight=canvas.height;resolve(canvas);}else resolve(image);}; image.onerror=()=>{clearTimeout(timer);resolve(null);}; image.src=ctx.mediaUrl(sb.id,e.path);});
        } else if(!imageType && (e.size || 0)<8*1024*1024) value=String(await readDoc({sandboxId:sb.id,path:e.path,label:e.name}) || "").slice(0,1500);   // un aperçu, pas le document : la page du casque saturait (plantage)
        else value=null;
        previewCache.set(key,value); if(previewCache.size>24) previewCache.delete(previewCache.keys().next().value);
      }
      if(prop.disposed) return;
      prop.data.preview=imageType?"":String(value || ""); prop.data.image=imageType?value:null;
      if(value) { const next=paperTexture(e,false,prop.data.preview,prop.data.image); prop.data.tex.tex.dispose(); prop.data.tex=next; prop.data.face.map=next.tex; prop.data.face.needsUpdate=true; }
    } catch { /* The named card remains usable if the preview is unavailable. */ }
  }

  /// Emplacements de l'éventail au-dessus d'un dossier ouvert, tournés vers l'utilisateur.
  function fanSlots(folder, n) {
    const base = folder.obj.position.clone();
    const h = headLocal();
    const toUser = new THREE.Vector3(h.x - base.x, 0, h.z - base.z).normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(toUser).normalize().negate();
    const slots = [];
    const perRow = Math.min(n, 5);
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 5), col = i % 5, inRow = row === Math.floor((n - 1) / 5) ? ((n - 1) % 5) + 1 : perRow;
      const x = (col - (inRow - 1) / 2) * 0.088;
      const arc = -Math.abs(x) * 0.35;
      const p = base.clone().addScaledVector(right, x).addScaledVector(toUser, 0.05 + arc).add(new THREE.Vector3(0, 0.2 + row * 0.115 - Math.abs(x) * 0.15, 0));
      slots.push({ p, yaw: Math.atan2(h.x - p.x, h.z - p.z) - x * 1.2 });
    }
    return slots;
  }
  const PER_PAGE = 10;
  async function openFolder(folder, path = folder.data.path) {
    folder.data.path = path;
    folder.data.open = true;
    sfx("open", folder.obj.position);
    folder.data.fan.forEach((f) => sendHome(f, folder.obj.position.clone().add(new THREE.Vector3(0, 0.06, 0)), true));
    const key = `${folder.data.sandbox.id}:${path}`;
    let entries = dirCache.get(key);
    if (!entries) {
      entries = await listDir(folder.data.sandbox.id, path);
      // Ne garde en cache qu'une VRAIE réponse non vide : un échec ou un
      // dossier vide se redemande à la prochaine ouverture.
      if (!entries.error && entries.length) dirCache.set(key, entries);
    }
    if (!folder.data.open || folder.data.path !== path) return;
    if (entries.error) {
      comment(`Je n'arrive pas à ouvrir ${folder.data.sandbox.name} : ${entries.error}`, `I can't open ${folder.data.sandbox.name}: ${entries.error}`, { force: true });
      closeFolder(folder);
      return;
    }
    folder.data.entries = entries;
    folder.data.label.redraw((g, w, h) => folderLabel(g, w, h, path ? `${folder.data.sandbox.name} › ${path.split("/").pop()}` : folder.data.sandbox.name, entries.length, folder.data.color));
    layoutFan(folder);
    const files = entries.filter((e) => !e.is_dir).length, dirs = entries.length - files;
    if (!folder.data.commented?.has(path)) {
      (folder.data.commented ||= new Set()).add(path);
      comment(
        !entries.length ? `Le dossier ${folder.data.sandbox.name} est vide.` : `${folder.data.sandbox.name} : ${files} fichier${files > 1 ? "s" : ""}${dirs ? ` et ${dirs} dossier${dirs > 1 ? "s" : ""}` : ""}. Prends-en un et lance-le-moi.`,
        !entries.length ? `${folder.data.sandbox.name} is empty.` : `${folder.data.sandbox.name}: ${files} file${files > 1 ? "s" : ""}${dirs ? ` and ${dirs} folder${dirs > 1 ? "s" : ""}` : ""}. Grab one and toss it to me.`);
    }
  }
  function layoutFan(folder) {
    const { entries, page } = folder.data;
    for (const f of folder.data.fan) dispose(f);
    folder.data.fan = [];
    const list = entries.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
    const extra = [];
    if (folder.data.path) extra.push({ name: T("Retour", "Back"), is_dir: true, nav: "up", arrow: "up" });
    if (page > 0) extra.push({ name: T("Précédents", "Previous"), is_dir: true, nav: "prev", arrow: "left" });
    if (entries.length > (page + 1) * PER_PAGE) extra.push({ name: T("Suivants", "Next"), is_dir: true, nav: "next", arrow: "right" });
    const show = [...list, ...extra];
    const slots = fanSlots(folder, show.length);
    const from = folder.obj.position.clone().add(new THREE.Vector3(0, 0.06, 0));
    show.forEach((e, i) => {
      const f = createFile(e, folder, from);
      f.home = slots[i].p; f.homeYaw = slots[i].yaw;
      f.state = "home"; f.delay = i * 45; f.t0 = performance.now();
      f.obj.scale.setScalar(0.3);
      folder.data.fan.push(f);
    });
  }
  function closeFolder(folder) {
    folder.data.open = false;
    sfx("paper", folder.obj.position);
    const into = folder.obj.position.clone().add(new THREE.Vector3(0, 0.06, 0));
    folder.data.fan.forEach((f) => sendHome(f, into, true));
    folder.data.label.redraw((g, w, h) => folderLabel(g, w, h, folder.data.sandbox.name, folder.data.entries?.length ?? null, folder.data.color));
  }
  /// Retour d'une feuille à sa place (ou rentrée dans le dossier, puis supprimée).
  function sendHome(f, to = null, vanish = false) {
    f.state = "home"; f.t0 = performance.now(); f.delay = 0;
    if (to) f.home = to;
    f.vanish = vanish;
  }

  // ---- Agents --------------------------------------------------------------
  const figurines = new Map(); // agentId → prop
  const avatarImgs = new Map();
  function img(src) {
    let im = avatarImgs.get(src);
    if (!im) { im = new Image(); im.onload = () => figurines.forEach((f) => f.data.dirty = true); im.src = src; avatarImgs.set(src, im); }
    return im.complete && im.naturalWidth ? im : null;
  }
  function drawFigure(fig) {
    const a = fig.data.agent, st = fig.data.mood;
    fig.data.tex.redraw((g, w, h) => {
      for (const l of avatarLayers(a, { state: st, hands: true })) {
        if (fig.data.talkFrame && /\/face_[a-l]\.png$/.test(l.src)) {
          const parts = talkingFaceParts(l, Math.min(1, fig.data.talkFrame / 5));
          const eye = img(parts.eyeSrc), mouth = img(parts.mouthSrc);
          if (eye) for (const e of parts.eyes) g.drawImage(eye, e.x * w, e.y * h, e.w * w, e.h * h);
          if (mouth) { const m = parts.mouth; g.drawImage(mouth, m.x * w, m.y * h, m.w * w, m.h * h); }
          continue;
        }
        const im = img(l.src);
        if (!im) continue;
        const lw = l.w * w, lh = (l.h ?? (l.w * im.naturalHeight / im.naturalWidth)) * h;
        g.save(); g.translate(l.x * w + lw / 2, l.y * h + lh / 2);
        if (l.rot) g.rotate((l.rot * Math.PI) / 180);
        if (l.flip) g.scale(-1, 1);
        g.drawImage(im, -lw / 2, -lh / 2, lw, lh); g.restore();
      }
    });
    fig.data.dirty = false;
  }
  function bubbleTexture(fig) {
    const d = fig.data;
    d.bubble.redraw((g, w, h) => {
      const text = d.approval ? T("Je peux ?", "May I?") : d.stepText;
      if (!text) return;
      roundRect(g, 4, 4, w - 8, h * 0.62, 26);
      g.fillStyle = d.approval ? "rgba(255,207,107,0.96)" : "rgba(20,22,30,0.88)"; g.fill();
      g.beginPath(); g.moveTo(w / 2 - 16, h * 0.62); g.lineTo(w / 2, h * 0.62 + 22); g.lineTo(w / 2 + 16, h * 0.62); g.fill();
      g.fillStyle = d.approval ? "#1b1c22" : "#f4f5f8"; g.font = `600 30px ${font}`; g.textAlign = "center"; g.textBaseline = "middle";
      const lines = wrap(g, text, w - 50).slice(0, 2);
      lines.forEach((l, k) => g.fillText(l, w / 2, h * 0.31 + (k - (lines.length - 1) / 2) * 36));
    });
  }
  function createFigurine(agent, pos) {
    const group = new THREE.Group();
    const color = new THREE.Color(avatarColor(agent));
    // Socle lumineux à la couleur de l'agent.
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.012, 40), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.4 }));
    base.position.y = 0.006;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.003, 8, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.014;
    const body = new THREE.Group();
    const tex = canvasTex(256, 256, () => {});
    const sprite = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.11), new THREE.MeshBasicMaterial({ map: tex.tex, transparent: true, alphaTest: 0.05, side: THREE.DoubleSide }));
    sprite.position.y = 0.068;
    body.add(sprite);
    const name = canvasTex(256, 56, (g, w, h) => {
      g.font = `600 30px ${font}`; g.textAlign = "center"; g.textBaseline = "middle";
      roundRect(g, 10, 6, w - 20, h - 12, (h - 12) / 2); g.fillStyle = "rgba(0,0,0,0.6)"; g.fill();
      g.fillStyle = "#fff"; g.fillText(agent.name || "Agent", w / 2, h / 2 + 1);
    });
    const nameMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.0165), new THREE.MeshBasicMaterial({ map: name.tex, transparent: true, depthWrite: false }));
    nameMesh.position.set(0, -0.006, 0.052);
    nameMesh.rotation.x = -0.5;
    const bubble = canvasTex(512, 200, () => {});
    const bubbleMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.0625), new THREE.MeshBasicMaterial({ map: bubble.tex, transparent: true, depthWrite: false }));
    bubbleMesh.position.y = 0.17; bubbleMesh.visible = false;
    // Boutons ✓ ✗ de l'approbation (sous-objets visables).
    const btn = (icon, col, x) => {
      const t = canvasTex(96, 96, (g, w, h) => { g.beginPath(); g.arc(w / 2, h / 2, 44, 0, Math.PI * 2); g.fillStyle = col; g.fill(); drawIcon(g, icon, 22, 22, 52, "#ffffff", 3.2); });
      const m = new THREE.Mesh(new THREE.CircleGeometry(0.018, 32), new THREE.MeshBasicMaterial({ map: t.tex, transparent: true }));
      m.position.set(x, 0.205, 0.004); m.visible = false;
      return m;
    };
    const yes = btn("check", "#30a46c", -0.03), no = btn("x", "#e5484d", 0.03);
    // × « ranger l'agent » : apparaît au survol, au-dessus de l'épaule.
    const dismiss = btn("x", "#3a3f4f", 0.058); dismiss.position.set(0.058, 0.13, 0.07); dismiss.scale.setScalar(0.75);
    body.add(bubbleMesh, yes, no, dismiss);
    const workspace=slab(.23,.14,.008,color,{glass:true}); workspace.rotation.x=-Math.PI/2; workspace.position.set(0,.002,.04);
    const tray=slab(.058,.003,.003,0xddf0ff); tray.position.set(.073,.008,.052);
    const result=createSculptedIcon("documents",{color:color.getHex()}); result.scale.setScalar(.033); result.position.set(.079,.053,.03); result.visible=false;
    const shadow=contactShadow(.30,.23); shadow.position.set(0,-.002,.04);
    group.add(workspace,tray,result,shadow,base,ring,body,nameMesh);
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.15, 16), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.075;
    group.add(hit);
    group.position.copy(pos);
    const resultHit = new THREE.Mesh(new THREE.BoxGeometry(.044,.050,.028),new THREE.MeshBasicMaterial({visible:false})); resultHit.position.copy(result.position); resultHit.visible=false; group.add(resultHit);
    const fig = makeProp("agent", group, hit, { agent, tex, sprite, body, ring, base, bubble, bubbleMesh, yes, no, workspace, result, resultHit, received: [], mood: "idle", stepText: "", approval: null, hop: 0, dirty: true });
    resultHit.userData.prop={id:++seq,kind:"report",parent:fig,obj:resultHit,hit:resultHit,data:{}};pickables.push(resultHit);
    fig.halfH = 0;
    fig.data.dismissBtn = dismiss;
    for (const [m, kind] of [[yes, "approve"], [no, "reject"], [dismiss, "dismiss"]]) {
      m.userData.prop = { id: ++seq, kind, parent: fig, obj: m, hit: m, data: {} };
      pickables.push(m);
    }
    figurines.set(agent.id, fig);
    drawFigure(fig);
    return fig;
  }
  /// Rangée de figurines à gauche de l'orbe, posées sur la surface sous elle.
  function teamSlot(i, n) {
    const o = toLocal(orbWorld());
    const h = headLocal();
    const toUser = new THREE.Vector3(h.x - o.x, 0, h.z - o.z).normalize();
    const left = new THREE.Vector3(0, 1, 0).cross(toUser).normalize();
    const p = o.clone().addScaledVector(left, 0.28 + i * 0.15).addScaledVector(toUser, 0.06 - i * 0.03);
    const g = groundAt(p);
    p.y = g > o.y - 0.6 ? g : o.y - 0.16;
    return p;
  }
  function syncTeam() {
    const team = ctx.apps?.team?.() || [];
    team.forEach((a, i) => {
      let fig = figurines.get(a.id);
      if (!fig) {
        const saved = savedPos[`agent:${a.id}`];
        fig = createFigurine(a, saved ? new THREE.Vector3().fromArray(saved) : teamSlot(i, team.length));
        fig.state = "rest";
        fig.obj.visible = shown && !hiddenAgents.has(a.id);
      } else if (fig.data.agent.avatar !== a.avatar || fig.data.agent.name !== a.name) { fig.data.agent = a; fig.data.dirty = true; }
      else fig.data.agent = a;
    });
    for (const [id, fig] of figurines) if (!team.some((a) => a.id === id)) { figurines.delete(id); dispose(fig); }
    // Approbations en attente : bulle sur l'agent concerné.
    const pending = ctx.apps?.approvals?.() || [];
    for (const fig of figurines.values()) {
      const ap = pending.find((p) => p.agent_id === fig.data.agent.id || p.agent === fig.data.agent.name) || null;
      if (!!ap !== !!fig.data.approval) {
        if (ap && hiddenAgents.has(fig.data.agent.id)) summonAgent(fig.data.agent.id, { quiet: true });
        fig.data.approval = ap;
        bubbleTexture(fig);
        if (ap && shown) { sfx("pop", fig.obj.position); comment(`${fig.data.agent.name} attend ton accord : pouce levé ou ✓.`, `${fig.data.agent.name} needs your OK: thumbs up or ✓.`, { force: true }); }
      }
    }
  }
  function agentEvent(type, msg) {
    const fig = figurines.get(msg.agent_id) || [...figurines.values()].find((f) => f.data.agent.name === msg.agent);
    if (!fig) return;
    // Un agent rangé qui se met au travail (tâche confiée, @mention, CRON…) revient.
    if (hiddenAgents.has(fig.data.agent.id)) summonAgent(fig.data.agent.id, { quiet: true });
    if (type === "agent-step") {
      fig.data.mood = "work"; fig.data.dirty = true;
      const received=slab(.038,.048,.003,0xe9f4ff); received.position.set(-.075,.032,.038);
      fig.obj.add(received); fig.data.received.push(received);
      if(fig.data.received.length>3) { const old=fig.data.received.shift(); fig.obj.remove(old); disposeDesign(old); }
      fig.data.received.forEach((card,i)=>{card.position.y=.030+i*.006;card.position.z=.035+i*.004;});
      fig.data.stepText = humanStep(msg.step || {}, ctx.lang)?.text || String(msg.step?.skill || "…");
      fig.data.stepUntil = performance.now() + 9000;
      bubbleTexture(fig);
    } else if (type === "agent-done") {
      fig.data.mood = msg.success === false ? "fail" : "done"; fig.data.dirty = true;
      fig.data.stepText = ""; bubbleTexture(fig);
      fig.data.celebrate = performance.now();
      fig.data.result.visible = true; fig.data.resultHit.visible = true; fig.data.report=msg.report || "";
      fig.data.resultTitle=msg.task || T("Résultat", "Result");
      sfx(msg.success === false ? "land" : "yes", fig.obj.position);
      setTimeout(() => { fig.data.mood = "idle"; fig.data.dirty = true; }, 12000);
    }
  }

  // ---------------------------------------------------------------- Ranger / rappeler les agents
  const hiddenAgents = new Set((() => { try { return JSON.parse(localStorage.getItem("xrHiddenAgents") || "[]"); } catch { return []; } })());
  const saveHidden = () => { try { localStorage.setItem("xrHiddenAgents", JSON.stringify([...hiddenAgents])); } catch {} picker?.invalidate(); };
  function dismissAgent(id) {
    const fig = figurines.get(id); if (!fig) return;
    hiddenAgents.add(id); saveHidden();
    sfx("whoosh", fig.obj.position);
    const t0 = performance.now(), s0 = fig.obj.scale.x;
    fig.vanishing = { t0, s0 };
    comment([`${fig.data.agent.name} rangé. Il revient dès qu'on l'appelle.`], [`${fig.data.agent.name} put away. Back as soon as you call.`], { force: true });
  }
  /// Fait (re)venir un agent DEVANT soi, sur la table : depuis le panneau Agents,
  /// ou tout seul quand il reçoit une tâche ou attend une approbation.
  function summonAgent(id, { quiet = false } = {}) {
    let fig = figurines.get(id);
    if (!fig) { syncTeam(); fig = figurines.get(id); if (!fig) return; }
    hiddenAgents.delete(id); saveHidden();
    fig.vanishing = null;
    const pose = headPose(), fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quat); fwd.y = 0; fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const visible = [...figurines.values()].filter((f) => f !== fig && f.obj.visible).length;
    const w = pose.pos.clone().addScaledVector(fwd, 0.55).addScaledVector(right, -0.25 + (visible % 4) * 0.12);
    w.y = pose.pos.y - 0.42;
    const local = toLocal(w), g = groundAt(local); if (g > local.y - 0.25 && g < local.y + 0.2) local.y = g;
    fig.obj.position.copy(local); fig.obj.visible = true; fig.state = "rest";
    fig.appear = performance.now(); fig.data.hop = performance.now();
    sfx("land", fig.obj.position, 0.5); persist();
    if (!quiet) comment(["Me voilà !", "Présent."], ["Here I am!", "Ready."], { force: true, voice: fig.data.agent.voice || "", at: () => toWorld(fig.obj.position.clone().add(new THREE.Vector3(0, 0.1, 0))) });
  }
  // Panneau « Agents » : toute l'équipe, posée sur la table ou rangée.
  let picker = null, pickerPage = 0;
  function openPicker() {
    if (!picker) {
      picker = ctx.addPanel(new ctx.Panel({ width: 0.62, height: 0.78, title: T("Agents", "Agents"), closable: true, draw(c, p) {
        const team = ctx.apps?.team?.() || [], W = p.W, H = p.H - p.handleH, rowH = 112, per = Math.max(1, Math.floor((H - 110) / rowH));
        const pages = Math.max(1, Math.ceil(team.length / per)); pickerPage = Math.min(pickerPage, pages - 1);
        if (!team.length) { c.font = `400 26px ${THEME.font}`; c.fillStyle = THEME.dim; c.textAlign = "left"; c.textBaseline = "top"; c.fillText(T("Aucun agent : créez-en dans Lumen › Agents.", "No agents: create some in Lumen › Agents."), 30, 30); return; }
        team.slice(pickerPage * per, pickerPage * per + per).forEach((a, k) => {
          const y = 16 + k * rowH, out = !hiddenAgents.has(a.id), fig = figurines.get(a.id);
          roundRect(c, 18, y, W - 36, rowH - 12, 22); c.fillStyle = "rgba(255,255,255,0.06)"; c.fill();
          // Avatar (calques Kenney).
          const box = rowH - 28, ax = 30, ay = y + 8;
          for (const l of avatarLayers(a, { state: "idle", hands: true })) {
            const im = img(l.src); if (!im) continue;
            const lw = l.w * box, lh = (l.h ?? (l.w * im.naturalHeight / im.naturalWidth)) * box;
            c.save(); c.translate(ax + l.x * box + lw / 2, ay + l.y * box + lh / 2); if (l.rot) c.rotate(l.rot * Math.PI / 180); if (l.flip) c.scale(-1, 1); c.drawImage(im, -lw / 2, -lh / 2, lw, lh); c.restore();
          }
          c.textAlign = "left"; c.textBaseline = "top"; c.fillStyle = THEME.text; c.font = `600 28px ${THEME.font}`;
          c.fillText(String(a.name || "Agent").slice(0, 22), ax + box + 18, y + 18);
          c.font = `400 21px ${THEME.font}`; c.fillStyle = THEME.dim;
          c.fillText(fig?.data.mood === "work" ? T("Au travail", "Working") : out ? T("Sur la table", "On the table") : T("Rangé", "Put away"), ax + box + 18, y + 56);
          p.pill(`pk-call:${a.id}`, W - 330, y + 22, 140, 56, T("Appeler", "Call"), () => { summonAgent(a.id); if (!shown) { fig && (fig.obj.visible = true); } p.invalidate(); }, { active: true });
          p.pill(`pk-tog:${a.id}`, W - 178, y + 22, 140, 56, out ? T("Ranger", "Put away") : T("Poser", "Place"), () => { out ? dismissAgent(a.id) : summonAgent(a.id); p.invalidate(); });
        });
        if (pages > 1) {
          p.iconButton("pk-prev", 30, H - 86, 62, "", () => { pickerPage = Math.max(0, pickerPage - 1); p.invalidate(); }, { inContent: true, icon: "chevron-up" });
          p.iconButton("pk-next", 106, H - 86, 62, "", () => { pickerPage = Math.min(pages - 1, pickerPage + 1); p.invalidate(); }, { inContent: true, icon: "chevron-down" });
        }
        p.pill("pk-all", W - 290, H - 86, 256, 62, T("Tout ranger", "Put all away"), () => { for (const id of figurines.keys()) if (!hiddenAgents.has(id)) dismissAgent(id); p.invalidate(); });
      } }), new THREE.Vector3(-0.5, 0.05, -0.95), 0.35, false, "agents-picker");
      picker.object.visible = false;
      return openPicker();
    }
    ctx.apps?.refreshTeam?.()?.then(() => { syncTeam(); picker.invalidate(); });
    if (picker.visible) picker.close(); else { ctx.openNear(picker); picker.invalidate(); }
  }

  // ---------------------------------------------------------------- Sandboxes
  const dirCache = new Map();
  const dirWaiters = new Map();
  let reqSeq = 0;
  function listDir(sandboxId, path) {
    const id = `props:${++reqSeq}`;
    send({ type: "xr-sandbox-dir", id, sandboxId, path });
    return new Promise((resolve) => {
      dirWaiters.set(id, resolve);
      setTimeout(() => { if (dirWaiters.delete(id)) resolve(Object.assign([], { error: T("Lumen ne répond pas sur le Mac.", "Lumen isn't answering on the Mac.") })); }, 60000);
    });
  }
  const docWaiters = new Map();
  function readDoc(item) {
    const id = `props:${++reqSeq}`;
    send({ type: "xr-doc-read", id, item });
    return new Promise((resolve) => {
      docWaiters.set(id, resolve);
      setTimeout(() => { if (docWaiters.delete(id)) resolve(""); }, 15000);
    });
  }
  const shelves=[]; let pendingArrange=false;
  function ensureShelves(count) {
    const needed=Math.ceil(count/4), o=toLocal(orbWorld()), head=headLocal();
    const front=new THREE.Vector3(head.x-o.x,0,head.z-o.z).normalize();
    const right=new THREE.Vector3(front.z,0,-front.x);
    while(shelves.length<needed) {
      const i=shelves.length, group=new THREE.Group();
      const shelf=slab(.86,.23,.018,0x91bcff,{glass:true}); shelf.rotation.x=Math.PI/2; group.add(shelf);
      const lip=slab(.81,.003,.004,0xd6efff); lip.position.set(0,.008,.11); group.add(lip);
      const tag=labelMesh(T(`Étagère ${i+1}`,`Shelf ${i+1}`),.17); tag.position.set(0,-.025,.12); group.add(tag);
      group.position.copy(o).addScaledVector(right,.66).addScaledVector(front,-.06);
      group.position.y=o.y-.15+i*.24; group.rotation.y=Math.atan2(front.x,front.z);
      const hit=new THREE.Mesh(new THREE.BoxGeometry(.88,.05,.25),new THREE.MeshBasicMaterial({visible:false})); group.add(hit);
      const prop=makeProp("shelf",group,hit,{index:i}); prop.state="rest";
      const saved=savedPos[`shelf:${i}`]; if(saved) prop.obj.position.fromArray(saved);
      if(Number.isFinite(savedPos[`shelfYaw:${i}`]))prop.obj.rotation.y=savedPos[`shelfYaw:${i}`];
      shelves.push(prop);
    }
  }
  function shelfSlot(index) {
    const shelf=shelves[Math.floor(index/4)];
    shelf.obj.updateMatrixWorld(true); return toLocal(shelf.obj.localToWorld(new THREE.Vector3((index%4-1.5)*.20,.016,0)));
  }
  function arrangeShelves() {
    if(!folders.size){pendingArrange=true;return;}
    pendingArrange=false;ensureShelves(folders.size); let i=0;
    for(const folder of folders.values()) { if(folder.data.open) closeFolder(folder); folder.data.shelf={index:Math.floor(i/4),slot:i%4}; folder.home=shelfSlot(i++); folder.homeYaw=shelves[Math.floor((i-1)/4)].obj.rotation.y; folder.state="home"; folder.t0=performance.now(); }
    persist(); toast(T("Dossiers rangés sur les étagères", "Folders arranged on shelves"));
  }
  const folders = new Map(); // sandboxId → prop
  let savedPos = {};
  try { savedPos = JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; } catch {}
  function persist() {
    const out = {};
    for (const [id,f] of folders) {
      out[`folder:${id}`]=f.obj.position.toArray().map(v=>+v.toFixed(3));
      if(f.data.shelf)out[`binding:${id}`]={index:f.data.shelf.index,slot:f.data.shelf.slot,local:f.data.shelf.local?.toArray()};
    }
    for (const [id, f] of figurines) out[`agent:${id}`] = f.obj.position.toArray().map((v) => +v.toFixed(3));
    for(const shelf of shelves) {out[`shelf:${shelf.data.index}`]=shelf.obj.position.toArray().map(v=>+v.toFixed(3));out[`shelfYaw:${shelf.data.index}`]=shelf.obj.rotation.y;}
    savedPos = out;
    try { localStorage.setItem(LS_KEY, JSON.stringify(out)); } catch {}
  }
  function placeFolders(list) {
    const o = toLocal(orbWorld());
    const h = headLocal();
    const toUser = new THREE.Vector3(h.x - o.x, 0, h.z - o.z).normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(toUser).normalize().negate();
    ensureShelves(list.length);
    list.forEach((sb, i) => {
      if (folders.has(sb.id)) { folders.get(sb.id).data.sandbox = sb; return; }
      const saved = savedPos[`folder:${sb.id}`];
      let p;
      if (saved) p = new THREE.Vector3().fromArray(saved);
      else {
        p = shelfSlot(i);
      }
      const f = createFolder(sb, p);
      if(!saved) f.data.shelf={index:Math.floor(i/4),slot:i%4};
      const binding=savedPos[`binding:${sb.id}`];
      if(binding && shelves[binding.index]) f.data.shelf={...binding,local:Array.isArray(binding.local)?new THREE.Vector3().fromArray(binding.local):undefined};
      f.state = "rest";
      f.obj.scale.setScalar(0.01);
      f.appear = performance.now() + i * 80;
      folders.set(sb.id, f);
    });
    if(pendingArrange)arrangeShelves();
    // Dossiers empilés (anciennes positions qui se chevauchent) : on les étale.
    const pts=[...folders.values()].filter(f=>!f.data.shelf).map(f=>f.obj.position);
    const stacked=pts.some((p,i)=>pts.some((q,j)=>j>i&&p.distanceTo(q)<.14));
    if(pendingSummon || stacked){pendingSummon=false;summonFolders(list.length);}
  }
  /// « Dossiers » du dock : les dossiers (sandboxes) viennent DEVANT soi, en arc
  /// à hauteur de table — avant ils restaient sur les étagères à droite de
  /// l'orbe, souvent hors du champ. On y prend les fichiers à déposer sur
  /// l'orbe ou sur un agent.
  let pendingSummon=false;
  function summonFolders(n){
    if(!folders.size){
      comment(["Tu n'as encore aucun dossier : crée une sandbox dans Lumen, elle apparaîtra ici."],["You have no folders yet: create a sandbox in Lumen and it will appear here."],{force:true});
      return;
    }
    const pose=headPose(), fwd=new THREE.Vector3(0,0,-1).applyQuaternion(pose.quat); fwd.y=0; fwd.normalize();
    const right=new THREE.Vector3(-fwd.z,0,fwd.x);
    // Grille courbe à DROITE de l'orbe : 4 dossiers par rangée, 26 cm entre
    // deux centres (un dossier fait ~20 cm) — plus de dossiers empilés —, les
    // rangées montent par paliers de 18 cm. Le dock et l'orbe restent dégagés.
    const list=[...folders.values()], k=list.length, PER_ROW=4, DIST=.9, GAP=.26;
    list.forEach((f,i)=>{
      if(f.data.open) closeFolder(f);
      const row=Math.floor(i/PER_ROW), col=i%PER_ROW;
      const a=(22*Math.PI/180)+col*(GAP/DIST);
      const dir=fwd.clone().multiplyScalar(Math.cos(a)).addScaledVector(right,Math.sin(a));
      const w=pose.pos.clone().addScaledVector(dir,DIST);
      w.y=pose.pos.y-.2+row*.18;
      const local=toLocal(w);   // pas d'aimantation à la table : elle écraserait les rangées
      f.data.shelf=null; f.home=local; f.homeYaw=undefined; f.state="home"; f.t0=performance.now(); f.delay=i*60; f.obj.visible=true;
    });
    setTimeout(persist,1200);
    comment(["Tes dossiers. Ouvre-en un, attrape un fichier et lâche-le sur moi ou sur un agent."],["Your folders. Open one, grab a file and drop it on me or on an agent."],{force:true});
  }

  // ---------------------------------------------------------------- Montrer / ranger
  function show(on = !shown, opts = {}) {
    shown = on;
    for (const p of all) p.obj.visible = on;
    for (const [id, f] of figurines) if (hiddenAgents.has(id)) f.obj.visible = false;
    if (on) {
      send({ type: "xr-sandboxes" });
      ctx.apps?.refreshTeam?.()?.then(()=>{if(shown)syncTeam();});
      syncTeam();
      sfx("whoosh", toLocal(orbWorld()));
      if(!opts.summon) comment(["Voilà ton bureau.", "Tes dossiers et ton équipe."], ["Here's your desk.", "Your folders and your team."], { force: true });
      else if(folders.size) summonFolders(folders.size); else pendingSummon=true;
    } else {
      for (const f of folders.values()) if (f.data.open) closeFolder(f);
    }
    try { localStorage.setItem("xrDeskShown", on ? "1" : "0"); } catch {}
  }

  // ---------------------------------------------------------------- Interaction
  /// Appui bref (sans déplacer).
  async function click(prop, pointer) {
    ctx.haptic?.(pointer, 0.3, 30);
    if(prop.kind === "report") {const d=prop.parent.data;ctx.openDocument?.({title:`${d.agent.name} · ${d.resultTitle}`,text:d.report,origin:prop.hit.getWorldPosition(new THREE.Vector3())});return;}
    if(prop.kind === "shelf") { arrangeShelves(); return; }
    if (prop.kind === "dismiss") { dismissAgent(prop.parent.data.agent.id); return; }
    if (prop.kind === "approve" || prop.kind === "reject") {
      const fig = prop.parent;
      const ap = fig.data.approval;
      if (!ap) return;
      ctx.apps?.decide?.(ap, prop.kind === "approve");
      sfx(prop.kind === "approve" ? "yes" : "land", fig.obj.position);
      fig.data.approval = null; bubbleTexture(fig);
      comment(prop.kind === "approve" ? ["Merci, je continue.", "Super, j'y vais."] : ["D'accord, j'arrête.", "Compris, je laisse tomber."],
        prop.kind === "approve" ? ["Thanks, carrying on.", "Great, on it."] : ["Okay, stopping.", "Got it, dropping it."],
        { force: true, voice: fig.data.agent.voice || "", at: () => toWorld(fig.obj.position.clone().add(new THREE.Vector3(0, 0.1, 0))) });
      return;
    }
    if (prop.kind === "folder") {
      if (prop.data.open) closeFolder(prop); else { prop.data.page = 0; openFolder(prop, ""); }
      return;
    }
    if (prop.kind === "subfolder") {
      const folder = prop.data.folder, e = prop.data.entry;
      if (e.nav === "next") { folder.data.page++; layoutFan(folder); sfx("paper", folder.obj.position); return; }
      if (e.nav === "prev") { folder.data.page = Math.max(0, folder.data.page - 1); layoutFan(folder); sfx("paper", folder.obj.position); return; }
      folder.data.page = 0;
      openFolder(folder, e.nav === "up" ? folder.data.path.split("/").slice(0, -1).join("/") : e.path);
      return;
    }
    if (prop.kind === "file") { inspect(prop); return; }
    if (prop.kind === "agent") {
      const a = prop.data.agent;
      prop.data.hop = performance.now();
      sfx("pop", prop.obj.position);
      comment(["Oui ?", "Je t'écoute.", "Dis-moi."], ["Yes?", "I'm listening.", "Tell me."], { force: true, voice: a.voice || "", at: () => toWorld(prop.obj.position.clone().add(new THREE.Vector3(0, 0.1, 0))) });
      ctx.whenSilent?.(() => ctx.dictate?.(T(`Que doit faire ${a.name} ?`, `What should ${a.name} do?`), (text) => ctx.apps?.giveTask?.(a, text)));
    }
  }
  /// La feuille vient devant les yeux, en grand, avec le début du texte.
  let inspected = null;
  async function inspect(f) {
    if(ctx.openDocument) {
      const item=itemOf(f);
      ctx.openDocument({title:f.data.entry.name,text:f.data.preview || T("Chargement de l'aperçu…","Loading preview…"),image:f.data.image,origin:toWorld(f.obj.position),item});
      const index=previewQueue.indexOf(f);if(index>=0){previewQueue.splice(index,1);previewQueue.unshift(f);}
      await f.data.previewReady;
      if(!f.disposed)ctx.updateDocument?.({item,text:f.data.preview,image:f.data.image});return;
    }
    if (inspected === f) { inspected = null; sendHome(f); f.obj.scale.setScalar(1); return; }
    if (inspected) { sendHome(inspected); inspected.obj.scale.setScalar(1); }
    inspected = f;
    const { pos, quat } = headPose();
    const target = toLocal(pos.clone().addScaledVector(new THREE.Vector3(0, -0.08, -1).applyQuaternion(quat).normalize(), 0.42));
    f.state = "inspect"; f.inspectTo = target; f.t0 = performance.now();
    sfx("paper", f.obj.position);
    const e = f.data.entry;
    const st = styleOf(e.name);
    comment(`${e.name.replace(/\.[^.]+$/, "")}, ${st.label === "IMG" ? "une image" : st.label === "PDF" ? "un PDF" : "un document"}.`, `${e.name.replace(/\.[^.]+$/, "")}, ${st.label === "IMG" ? "an image" : "a document"}.`);
    if (!f.data.preview && st.label !== "IMG") {
      const text = await readDoc({ sandboxId: f.data.folder.data.sandbox.id, path: e.path, label: e.name });
      f.data.preview = String(text || "").replace(/\s+/g, " ").slice(0, 1400) || T("(pas de texte lisible)", "(no readable text)");
    }
    if (inspected === f) {
      f.data.inspectedTexture?.tex.dispose();
      const big = paperTexture(e,true,f.data.preview || "",f.data.image); f.data.inspectedTexture=big;
      f.data.face.map = big.tex; f.data.face.needsUpdate = true;
    }
  }

  // ---- Saisie ------------------------------------------------------------------
  /// Le pointeur prend l'objet. `pointer.propDrag` est tenu par xr.js.
  function grab(prop, pointer, point) {
    if (prop.kind === "approve" || prop.kind === "reject" || prop.kind === "report" || prop.kind === "dismiss") return null;
    ctx.haptic?.(pointer, 0.5, 25);
    sfx("grab", prop.obj.position);
    if (inspected === prop) { inspected = null; prop.data.face.map = prop.data.tex.tex; }
    const local = toLocal(point);
    if(prop.kind==="folder") prop.data.shelf=null;
    prop.state = "held";
    prop.vel.set(0, 0, 0);
    prop.hist = [];
    return { prop, offset: prop.obj.position.clone().sub(local) };
  }
  function drag(d, worldPoint, now) {
    const p = d.prop;
    const target = toLocal(worldPoint).add(d.offset);
    p.obj.position.lerp(target, 0.6);
    p.hist.push({ t: now, p: p.obj.position.clone() });
    while (p.hist.length > 2 && now - p.hist[0].t > 110) p.hist.shift();
    if (p.kind === "agent" || p.kind === "folder") faceUser(p.obj, 0.2);
    else faceUser(p.obj, 0.15);
    // L'orbe regarde ce qu'on lui apporte.
    if (p.kind === "file" && toWorld(p.obj.position).distanceTo(orbWorld()) < 0.45) ctx.lookAt?.(toWorld(p.obj.position));
  }
  function release(d, pointer) {
    const p = d.prop;
    const h = p.hist || [];
    if (h.length >= 2) {
      const a = h[0], b = h[h.length - 1];
      const dt = Math.max(0.016, (b.t - a.t) / 1000);
      p.vel.copy(b.p).sub(a.p).divideScalar(dt);
      // Un lancer de main dépasse rarement 3,5 m/s : au-delà, c'est un saut de
      // suivi (ou un glisser instantané à la souris), pas un geste.
      if (p.vel.length() > 3.5) p.vel.setLength(3.5);
    }
    const speed = p.vel.length();
    ctx.haptic?.(pointer, 0.3, 20);
    const wp = toWorld(p.obj.position);
    if(p.kind === "shelf") { p.state="rest"; p.vel.set(0,0,0); persist(); return; }
    if(p.kind === "folder") {
      const fig=[...figurines.values()].find(f=>toWorld(f.obj.position.clone().add(new THREE.Vector3(0,.07*f.obj.scale.x,0))).distanceTo(wp)<.18*Math.max(1,f.obj.scale.x));
      if(fig){receiveFolder(p,fig);return;}
    }
    if (p.kind === "file") {
      if (wp.distanceTo(orbWorld()) < 0.24) return dropOnOrb(p);
      const fig = [...figurines.values()].find((f) => toWorld(f.obj.position.clone().add(new THREE.Vector3(0, 0.07 * f.obj.scale.x, 0))).distanceTo(wp) < 0.12 * Math.max(1, f.obj.scale.x));
      if (fig) return dropOnAgent(p, fig);
      if (speed > 0.9) {
        p.state = "fall"; p.spin.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 9);
        sfx("whoosh", p.obj.position, speed);
        if (Math.random() < 0.35) comment(["Hop !", "Joli lancer.", "Attention à la table !"], ["Whoa!", "Nice throw.", "Mind the table!"]);
        return;
      }
      sendHome(p);
      return;
    }
    if (p.kind === "subfolder") { sendHome(p); return; }
    if(p.kind === "folder") {
      for(const shelf of shelves) {
        shelf.obj.updateMatrixWorld(true); const local=shelf.obj.worldToLocal(wp.clone());
        if(Math.abs(local.x)<.43 && Math.abs(local.z)<.16 && Math.abs(local.y)<.16) {
          p.data.shelf={index:shelf.data.index,local:local.clone().setY(.016)}; local.y=.016; p.obj.position.copy(toLocal(shelf.obj.localToWorld(local))); p.state="rest"; p.vel.set(0,0,0); persist(); return;
        }
      }
    }
    // Dossiers et figurines : ils tombent sur la surface en dessous (ou restent
    // en l'air s'il n'y en a pas à portée), et gardent leur place.
    const g = groundAt(p.obj.position);
    p.state = speed > 0.6 || p.obj.position.y - g < 0.5 ? "fall" : "float";
    if (p.state === "float") p.vel.set(0, 0, 0);
    if (p.kind === "folder" && p.data.open) closeFolder(p);
  }
  function receiveFolder(folder,fig) {
    folder.vel.set(0,0,0);folder.state="rest";folder.data.shelf=null;
    folder.obj.position.copy(fig.obj.position).add(new THREE.Vector3(.20,.015,.01));
    const agent=fig.data.agent,sb=folder.data.sandbox;
    fig.data.hop=performance.now();sfx("catch",fig.obj.position);persist();
    comment(`J'ai le dossier ${sb.name}. Que dois-je faire ?`,`I have the ${sb.name} folder. What should I do?`,{force:true,voice:agent.voice || "",at:()=>toWorld(fig.obj.position)});
    ctx.whenSilent?.(()=>ctx.dictate?.(T(`Que doit faire ${agent.name} avec ${sb.name} ?`,`What should ${agent.name} do with ${sb.name}?`),text=>{
      const task=String(text || "").trim();if(!task)return;
      ctx.apps?.giveTask?.(agent,`${task}\n\n${T("Dossier sandbox","Sandbox folder")} : ${sb.name} (id: ${sb.id}), ${T("chemin","path")} : ${folder.data.path || "/"}.`);
      fig.data.mood="work";fig.data.dirty=true;
    }));
  }
  function absorbInto(p, target, then) {
    p.state = "absorb"; p.absorbTo = target; p.t0 = performance.now(); p.absorbFrom = p.obj.position.clone(); p.then = then;
  }
  function itemOf(p) {
    const e = p.data.entry, sb = p.data.folder.data.sandbox;
    return { sandboxId: sb.id, path: e.path, label: e.name, sandboxName: sb.name };
  }
  function dropOnOrb(p) {
    const it = itemOf(p);
    absorbInto(p, () => toLocal(orbWorld()), () => {
      sfx("absorb", toLocal(orbWorld()));
      ctx.pulseOrb?.();
      send({ type: "attach-doc-ref", item: it });
      ctx.say?.(T(`J'ai ${it.label.replace(/\.[^.]+$/, "")}. Qu'est-ce que tu veux en faire ?`, `Got ${it.label.replace(/\.[^.]+$/, "")}. What should I do with it?`));
      lastComment = performance.now();
      ctx.whenSilent?.(() => ctx.dictate?.(T("Ta question sur le document…", "Your question about the document…"), (text) => {
        ctx.sendChat?.(String(text || "").trim() || T(`Résume « ${it.label} ».`, `Summarise “${it.label}”.`));
      }));
      dispose(p);
      const fan = p.data.folder.data.fan; const i = fan.indexOf(p); if (i >= 0) fan.splice(i, 1);
    });
  }
  function dropOnAgent(p, fig) {
    const it = itemOf(p);
    const a = fig.data.agent;
    const at = () => toWorld(fig.obj.position.clone().add(new THREE.Vector3(0, 0.1, 0)));
    absorbInto(p, () => fig.obj.position.clone().add(new THREE.Vector3(0, 0.07, 0.02)), async () => {
      sfx("catch", fig.obj.position);
      fig.data.hop = performance.now();
      fig.data.mood = "work"; fig.data.dirty = true;
      dispose(p);
      const fan = p.data.folder.data.fan; const i = fan.indexOf(p); if (i >= 0) fan.splice(i, 1);
      comment(`Bien reçu, ${it.label.replace(/\.[^.]+$/, "")}. Je dois en faire quoi ?`, `Got ${it.label.replace(/\.[^.]+$/, "")}. What should I do with it?`, { force: true, voice: a.voice || "", at });
      const excerpt = styleOf(it.label).label === "IMG" ? "" : String(await readDoc(it) || "").slice(0, 4000);
      ctx.whenSilent?.(() => ctx.dictate?.(T(`Que doit faire ${a.name} avec ce fichier ?`, `What should ${a.name} do with this file?`), (text) => {
        const task = String(text || "").trim() || T("Analyse ce fichier et fais-moi un compte rendu.", "Analyse this file and report back.");
        ctx.apps?.giveTask?.(a, `${task}\n\n${T("Fichier", "File")} : « ${it.label} » (sandbox « ${it.sandboxName} », ${T("chemin", "path")} ${it.path})${excerpt ? `\n\n${T("Début du contenu", "Content excerpt")} :\n${excerpt}` : ""}`);
        comment(["C'est parti.", "Je m'en occupe."], ["On it.", "I'll take care of it."], { force: true, voice: a.voice || "", at });
      }));
    });
  }
  /// Pouce levé : approuve la demande de l'agent regardé (ou la seule en attente).
  function thumbsUp() {
    const waiting = [...figurines.values()].filter((f) => f.data.approval);
    if (!waiting.length) return false;
    const { pos, quat } = headPose();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    let best = waiting[0], bestDot = -2;
    for (const f of waiting) { const d = toWorld(f.obj.position).sub(pos).normalize().dot(fwd); if (d > bestDot) { bestDot = d; best = f; } }
    click(best.data.yes.userData.prop, null);
    return true;
  }

  // ---------------------------------------------------------------- Boucle
  let lastT = performance.now();
  let teamTimer = 0;
  function tick(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (!shown) return;
    if (now - teamTimer > 4000) {
      teamTimer = now;
      // L'équipe et ses approbations : relues toutes les 16 s (les étapes, elles, arrivent en direct).
      if (!(Math.round(now / 4000) % 4)) ctx.apps?.refreshTeam?.();
      syncTeam();
    }
    const head = headLocal();
    for (const p of [...all]) {
      if(p.kind==="folder" && p.data.shelf && p.state==="rest") {
        const shelf=shelves[p.data.shelf.index];
        if(shelf){shelf.obj.updateMatrixWorld(true);const offset=p.data.shelf.local || new THREE.Vector3((p.data.shelf.slot-1.5)*.20,.016,0);p.obj.position.copy(toLocal(shelf.obj.localToWorld(offset.clone())));p.obj.rotation.y=shelf.obj.rotation.y;}
      }
      // Apparition « pop ».
      const unit = p.kind === "agent" ? (ctx.settings?.agentScale || 1) : 1;
      if (p.appear) {
        const k = Math.min(1, Math.max(0, (now - p.appear) / 350));
        p.obj.scale.setScalar(unit * (0.01 + (1 + Math.sin(k * Math.PI) * 0.15) * k));
        if (k >= 1) { p.appear = 0; p.obj.scale.setScalar(unit); sfx("land", p.obj.position, 0.4); }
      }
      if (p.state === "home" && p.home) {
        if (now - p.t0 < (p.delay || 0)) continue;
        p.obj.position.lerp(p.home, Math.min(1, dt * 9));
        const s = p.obj.scale.x + (unit - p.obj.scale.x) * Math.min(1, dt * 8);
        p.obj.scale.setScalar(p.vanish ? Math.max(0.05, p.obj.scale.x - dt * 3) : s);
        const yaw = p.homeYaw ?? Math.atan2(head.x - p.obj.position.x, head.z - p.obj.position.z);
        p.obj.rotation.x *= 0.85; p.obj.rotation.z *= 0.85;
        p.obj.rotation.y += Math.atan2(Math.sin(yaw - p.obj.rotation.y), Math.cos(yaw - p.obj.rotation.y)) * Math.min(1, dt * 8);
        if (p.vanish && p.obj.position.distanceTo(p.home) < 0.02) { dispose(p); continue; }
        if (!p.vanish && p.obj.position.distanceTo(p.home) < 0.003) {p.state=p.kind==="folder"?"rest":"fan";if(p.kind==="folder")persist();}
      } else if (p.state === "fan") {
        // Légère respiration de l'éventail.
        p.obj.position.y = p.home.y + (ctx.settings?.reducedMotion ? 0 : Math.sin(now / 900 + p.id) * .002);
      } else if (p.state === "inspect") {
        p.obj.position.lerp(p.inspectTo, Math.min(1, dt * 7));
        const s = p.obj.scale.x + (3.2 - p.obj.scale.x) * Math.min(1, dt * 6);
        p.obj.scale.setScalar(s);
        p.obj.rotation.x *= 0.8; p.obj.rotation.z *= 0.8;
        faceUser(p.obj, 0.3);
      } else if (p.state === "absorb") {
        const k = Math.min(1, (now - p.t0) / 420);
        const to = p.absorbTo();
        p.obj.position.copy(p.absorbFrom).lerp(to, k * k);
        p.obj.position.y += Math.sin(k * Math.PI) * 0.08;
        p.obj.scale.setScalar(Math.max(0.05, 1 - k * 0.95));
        p.obj.rotation.y += dt * 12;
        if (k >= 1) { const then = p.then; p.state = "gone"; then?.(); }
      } else if (p.state === "fall") {
        p.vel.y -= G * dt;
        p.vel.multiplyScalar(0.995);
        p.obj.position.addScaledVector(p.vel, dt);
        p.obj.rotation.x += p.spin.x * dt; p.obj.rotation.y += p.spin.y * dt; p.obj.rotation.z += p.spin.z * dt;
        const floor = groundAt(p.obj.position) + (p.kind === "file" ? 0.0015 : 0);
        if (p.obj.position.y <= floor) {
          p.obj.position.y = floor;
          const impact = Math.abs(p.vel.y);
          if (impact > 0.25) sfx(p.kind === "file" ? "paper" : "land", p.obj.position, impact / 2);
          p.vel.y = impact > 0.4 ? impact * 0.25 : 0;
          p.vel.x *= 0.55; p.vel.z *= 0.55; p.spin.multiplyScalar(0.5);
          if (p.kind === "file") { p.obj.rotation.x += (-Math.PI / 2 - p.obj.rotation.x) * 0.5; p.obj.rotation.z *= 0.5; }
          else { p.obj.rotation.x *= 0.4; p.obj.rotation.z *= 0.4; }
          if (p.vel.length() < 0.06) {
            p.state = "rest"; p.vel.set(0, 0, 0);
            if (p.kind === "file") { p.restAt = now; p.obj.rotation.x = -Math.PI / 2; }
            else persist();
          }
        }
      } else if (p.state === "rest" && p.kind === "file" && now - p.restAt > 4500) {
        // Une feuille lancée revient d'elle-même à l'éventail.
        p.obj.rotation.x = 0;
        sendHome(p);
      } else if (p.state === "float" && (p.kind === "folder" || p.kind === "agent")) {
        persist(); p.state = "rest";
      }
      if(p.kind === "folder") {
        const target=p.data.open ? -.46 : -p.hover*.13;
        p.data.hinge.rotation.x += (target-p.data.hinge.rotation.x)*Math.min(1,dt*9);
        p.data.visual.position.y=ctx.settings?.reducedMotion ? 0 : p.hover*.009;
        p.data.papers.position.y=p.hover*.005;
        p.data.shadow.material.opacity=1-p.hover*.35;
      }
      // Survol : la feuille se soulève un peu.
      if (p.kind === "file" || p.kind === "subfolder") {
        p.data.face && (p.data.face.emissiveIntensity = p.hover * 0.12);
        if (p.state === "fan") p.obj.position.y += p.hover * 0.012;
      }
    }
    // Figurines : vie propre.
    const agentScale = ctx.settings?.agentScale || 1;
    for (const fig of figurines.values()) {
      const d = fig.data;
      if (fig.vanishing) {
        const k = Math.min(1, (now - fig.vanishing.t0) / 350);
        fig.obj.scale.setScalar(Math.max(0.001, fig.vanishing.s0 * (1 - k)));
        if (k >= 1) { fig.obj.visible = false; fig.vanishing = null; fig.obj.scale.setScalar(agentScale); }
        continue;
      }
      if (!fig.obj.visible) continue;
      if (fig.hover > 0.3 || d.dismissBtn.userData.prop.hover > 0.3) d.hoverAt = now;
      d.dismissBtn.visible = now - (d.hoverAt || 0) < 1800 && !d.approval;
      const sc = fig.obj.scale.x + (agentScale - fig.obj.scale.x) * Math.min(1, dt * 8);
      if (Math.abs(sc - fig.obj.scale.x) > 1e-4) fig.obj.scale.setScalar(sc);
      if(now>(d.nextTalkAt || 0)) {
        d.nextTalkAt=now+(ctx.settings?.perf ? 100 : 50);
        const talkFrame=Math.round((ctx.agentVoiceLevel?.(d.agent.id) || 0)*5);
        if(talkFrame!==d.talkFrame){d.talkFrame=talkFrame;d.dirty=true;}
      }
      if (d.dirty) drawFigure(fig);
      faceUser(fig.obj);
      d.body.rotation.y = 0;
      const eyeTarget=fig.obj.worldToLocal(ctx.headPose().pos.clone());
      d.body.rotation.x=-Math.atan2(eyeTarget.y-.068,Math.hypot(eyeTarget.x,eyeTarget.z));
      let y = 0, sx = 1, sy = 1;
      const t = now / 1000;
      if (d.mood === "work") { y = Math.abs(Math.sin(t * 5)) * 0.012; d.ring.material.opacity = 0.5 + 0.3 * Math.sin(t * 6); d.ring.rotation.z += dt * 3; }
      else { y = Math.sin(t * 1.6 + fig.id) * 0.003; d.ring.material.opacity *= 0.92; }
      if (d.celebrate && now - d.celebrate < 900) { const k = (now - d.celebrate) / 900; y += Math.sin(k * Math.PI) * 0.05; }
      if (d.hop && now - d.hop < 400) y += Math.sin(((now - d.hop) / 400) * Math.PI) * 0.025;
      if (d.mood === "fail") { sy = 0.9; sx = 1.06; }
      // Parle : il « respire » au rythme de sa voix.
      const lvl = ctx.agentVoiceLevel?.(d.agent.id) || 0;
      if (lvl) { sy *= 1 + lvl * 0.08; sx *= 1 - lvl * 0.03; }
      if(ctx.settings?.reducedMotion) {y=0;sx=sy=1;}
      d.sprite.position.y = 0.068 + y;
      d.sprite.scale.set(sx, sy, 1);
      d.base.material.emissiveIntensity = 0.3 + (d.mood === "work" ? 0.35 + 0.2 * Math.sin(t * 6) : 0) + fig.hover * 0.4 + lvl * 0.6;
      const bubbleOn = !!d.approval || (d.stepText && now < (d.stepUntil || 0));
      d.bubbleMesh.visible = bubbleOn;
      d.yes.visible = d.no.visible = !!d.approval;
      if (!bubbleOn && d.stepText && now >= (d.stepUntil || 0)) { d.stepText = ""; if (d.mood === "work") { d.mood = "idle"; d.dirty = true; } }
    }
  }

  // ---------------------------------------------------------------- Messages
  function onMessage(msg) {
    if (msg.type === "xr-sandboxes") {
      if (msg.error) {
        pendingSummon = false;
        toast(T("Impossible de charger les dossiers. Réessayez depuis le dock.", "Could not load folders. Try again from the dock."));
      } else placeFolders(msg.items || []);
      return true;
    }
    if (msg.type === "xr-sandbox-dir") {
      const done = dirWaiters.get(msg.id);
      if (done) {
        dirWaiters.delete(msg.id);
        const list = (msg.entries || []).map((e) => ({ ...e, path: e.path || (msg.path ? `${msg.path}/${e.name}` : e.name) }));
        if (msg.error) list.error = String(msg.error);
        done(list);
      }
      return true;
    }
    if (msg.type === "xr-doc" && String(msg.id || "").startsWith("props:")) {
      const done = docWaiters.get(msg.id);
      if (done) { docWaiters.delete(msg.id); done(msg.text || ""); }
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- Survol
  let hoverSet = new Set();
  function setHovered(list) {
    const next = new Set(list);
    for (const p of next) if (!hoverSet.has(p) && (p.kind === "file" || p.kind === "folder" || p.kind === "agent")) sfx("hover", p.obj.position);
    for (const p of all) p.hover += ((next.has(p) || performance.now() < (p.highlightUntil || 0) ? 1 : 0) - p.hover) * 0.3;
    hoverSet = next;
  }
  /// Objet à portée de la main (saisie directe), sinon null.
  function nearest(worldPoint, maxDist = 0.07) {
    let best = null, bd = maxDist;
    for (const p of all) {
      if (!p.obj.visible || p.state === "absorb" || p.state === "gone") continue;
      const c = toWorld(p.obj.position.clone().add(new THREE.Vector3(0, p.kind === "folder" ? 0.07 : p.kind === "agent" ? 0.07 : 0, 0)));
      const d = c.distanceTo(worldPoint);
      if (d < bd) { bd = d; best = p; }
    }
    for(const fig of figurines.values())if(fig.obj.visible && fig.data.resultHit.visible){const hit=fig.data.resultHit,dist=hit.getWorldPosition(new THREE.Vector3()).distanceTo(worldPoint);if(dist<bd){bd=dist;best=hit.userData.prop;}}
    return best;
  }

  if (localStorage.getItem("xrDeskShown") === "1") setTimeout(() => show(true), 1500);

  return {
    get shown() { return shown; },
    show, toggle: () => show(!shown), arrangeShelves, hideAll: (on) => { root.visible = !on; }, openPicker, pickerOpen: () => !!picker?.visible, summonAgent, dismissAgent,
    search: (query) => { const q=String(query || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase(); return all.filter(p=>(p.kind==="folder" || p.kind==="file") && (p.data.entry?.name || p.data.sandbox?.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().includes(q)); },
    highlight: (matches) => { for(const p of matches) { p.hover=1; p.highlightUntil=performance.now()+6000; } },
    pickables: () => (shown ? pickables.filter((m) => m.visible !== false && (m.userData.prop?.obj?.visible ?? true) && m.parent?.visible !== false) : []),
    click, grab, drag, release, nearest, setHovered, tick, onMessage, agentEvent, thumbsUp,
    figurinePos: (agentId) => { const f = figurines.get(agentId); return f ? () => toWorld(f.obj.position.clone().add(new THREE.Vector3(0, 0.1 * f.obj.scale.x, 0))) : null; },
    /** Pour l'aperçu et les tests. */
    _debug: () => ({ folders: [...folders.values()], figurines: [...figurines.values()], all }),
  };
}
