// Objects of light — reusable, low-poly sculpted XR assets. No transmission
// pass, bloom or dynamic shadow map: silhouettes and layered materials do the work.
import * as THREE from '/lib/three.module.js';

const geometries = new Map(), materials = new Map();
function cached(map, key, build) {
  if (!map.has(key)) { const value = build(); value.userData.xrShared = true; map.set(key, value); }
  return map.get(key);
}
export function roundedGeometry(w = 1, h = 1, depth = .12, radius = .16) {
  const key = `round:${w}:${h}:${depth}:${radius}`;
  return cached(geometries, key, () => {
    const r = Math.min(radius, w / 2, h / 2), x = -w / 2, y = -h / 2;
    const shape = new THREE.Shape();
    shape.moveTo(x + r, y); shape.lineTo(x + w - r, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + r); shape.lineTo(x + w, y + h - r);
    shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h); shape.lineTo(x + r, y + h);
    shape.quadraticCurveTo(x, y + h, x, y + h - r); shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    const bevel = Math.min(depth * .22, r * .22);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(.001, depth - bevel * 2), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 8, steps: 1 });
    geo.translate(0, 0, -depth / 2 + bevel); geo.computeVertexNormals(); return geo;
  });
}
export function lightMaterial(color, glass = false) {
  color = color?.isColor ? color.getHex() : color;
  return cached(materials, `${color}:${glass}`, () => new THREE.MeshStandardMaterial({
    color, roughness: glass ? .38 : .27, metalness: .04,
    transparent: glass, opacity: glass ? .58 : 1, depthWrite: !glass,
    emissive: color, emissiveIntensity: glass ? .09 : .035,
  }));
}
export function slab(w, h, d, color, { glass = false, radius = Math.min(w, h) * .18 } = {}) {
  return new THREE.Mesh(roundedGeometry(w, h, d, radius), lightMaterial(color, glass));
}
function add(group, object, x = 0, y = 0, z = 0) { object.position.set(x, y, z); group.add(object); return object; }
function ball(radius, color, glass = false) {
  const geo = cached(geometries, `ball:${radius}`, () => new THREE.SphereGeometry(radius, 16, 10));
  return new THREE.Mesh(geo, lightMaterial(color, glass));
}
function tube(radius, thickness, color, arc = Math.PI * 2) {
  const geo = cached(geometries, `ring:${radius}:${thickness}:${arc}`, () => new THREE.TorusGeometry(radius, thickness, 6, 24, arc));
  return new THREE.Mesh(geo, lightMaterial(color));
}
function polygon(points, depth, color) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const key = `poly:${JSON.stringify(points)}:${depth}`;
  const geo = cached(geometries, key, () => { const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: .025, bevelThickness: .025, bevelSegments: 2, curveSegments: 3 }); g.translate(0, 0, -depth / 2); return g; });
  return new THREE.Mesh(geo, lightMaterial(color));
}
const COLORS = { folder: 0x458dff, documents: 0x58b5ff, calendar: 0xff6853, messages: 0xbd57f3, gallery: 0x478aff, data: 0x64eb89, mail: 0xff668e, search: 0x478eff, agents: 0x7873ee, settings: 0x87a7df, apps: 0xffad52, weather: 0xffd457, mic: 0xff789e, screen: 0x76acff, keyboard: 0x8e8ff2, shield: 0x58e77c, focus: 0x75dfce, shelves: 0x8d9bb5, eye: 0x5ab0ff, speaker: 0x3fd0a0, tools: 0xffa94d, brain: 0xff7eb6, target: 0x6f8cff, sun: 0xffb43d, team: 0x7873ee, refresh: 0x58b5ff };
export const SCULPTED_ICONS = Object.keys(COLORS);
export function iconKind(name) {
  if (/refresh|reload/.test(name)) return 'refresh';
  if (/folder|desk|files/.test(name)) return 'folder';
  if (/calendar|agenda|morning/.test(name)) return 'calendar';
  if (/message|chat/.test(name)) return 'messages';
  if (/image|photo|gallery|scan|look/.test(name)) return 'gallery';
  if (/chart|data|table|database|kanban/.test(name)) return 'data';
  if (/mail|notif|bell/.test(name)) return 'mail';
  if (/search/.test(name)) return 'search';
  if (/agent|bot|brain|people|users/.test(name)) return 'agents';
  if (/setting|tools|wrench/.test(name)) return 'settings';
  if (/weather|cloud/.test(name)) return 'weather';
  if (/mic|talk|voice|volume/.test(name)) return 'mic';
  if (/screen|monitor|mirror/.test(name)) return 'screen';
  if (/keyboard/.test(name)) return 'keyboard';
  if (/shield|approval/.test(name)) return 'shield';
  if (/focus|eye|center|locate/.test(name)) return 'focus';
  if (/book|doc|note|file/.test(name)) return 'documents';
  return 'apps';
}
export function createSculptedIcon(kind, { color = COLORS[kind] || COLORS.apps } = {}) {
  kind = COLORS[kind] ? kind : iconKind(kind);
  const g = new THREE.Group(); g.userData.iconKind = kind;
  const white = 0xf6faff;
  const line = (x, y, width = .46, z = .23) => add(g, slab(width, .047, .025, white), x, y, z);
  if (kind === 'refresh') {
    add(g, tube(.32, .065, color, Math.PI * 1.65)).rotation.z = .4;
    add(g, polygon([[.17,.36],[.40,.33],[.32,.10]], .07, color), 0, 0, .08);
    add(g, ball(.19, white, true), 0, 0, -.02).scale.z = .35;
  } else if (kind === 'folder') {
    add(g, slab(.91, .63, .13, color), 0, .04, -.05);
    add(g, slab(.36, .16, .11, color), -.26, .35, -.05);
    for (let i = 0; i < 3; i++) add(g, slab(.74, .52, .025, white), .015 * i, .035 + .025 * i, .025 + i * .035);
    add(g, slab(.98, .57, .09, color, { glass: true }), 0, -.09, .18).rotation.x = -.15;
  } else if (kind === 'documents') {
    add(g, slab(.65, .82, .11, color), .15, .12, -.05);
    add(g, slab(.70, .81, .08, 0xa6dfff, { glass: true }), -.10, -.08, .13);
    [0.12, -.04, -.20].forEach(y => line(-.1, y, .43)); line(-.2, -.34, .23);
  } else if (kind === 'calendar') {
    // Page blanche + bandeau rouge (jour de la semaine) + grand numéro, comme
    // l'icône Calendrier système ; deux anneaux de reliure. Le cadran est un
    // canvas OPAQUE plaqué sur la page (plus de carré sombre en transparence).
    add(g, slab(.82, .86, .12, white), 0, -.02, 0);
    add(g, slab(.82, .26, .13, color), 0, .30, .008);
    [-.22, .22].forEach(x => add(g, slab(.07, .2, .07, 0xd9dee8), x, .45, .07));
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 128;
    const c = canvas.getContext('2d');
    const paint = () => {
      const d = new Date();
      c.fillStyle = '#f6faff'; c.fillRect(0, 0, 160, 128);
      c.fillStyle = '#1b2236'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = '700 92px sans-serif'; c.fillText(String(d.getDate()), 80, 70);
    };
    paint();
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    add(g, new THREE.Mesh(new THREE.PlaneGeometry(.66, .528), new THREE.MeshBasicMaterial({ map: texture })), 0, -.13, .062);
    const head = document.createElement('canvas'); head.width = 192; head.height = 48;
    const h = head.getContext('2d');
    const paintHead = () => {
      h.clearRect(0, 0, 192, 48); h.fillStyle = '#ffffff'; h.textAlign = 'center'; h.textBaseline = 'middle'; h.font = '700 30px sans-serif';
      h.fillText(new Date().toLocaleDateString(document.documentElement.lang === 'en' ? 'en-GB' : 'fr-FR', { weekday: 'short' }).replace('.', '').toUpperCase(), 96, 26);
    };
    paintHead();
    const headTex = new THREE.CanvasTexture(head); headTex.colorSpace = THREE.SRGBColorSpace;
    add(g, new THREE.Mesh(new THREE.PlaneGeometry(.6, .15), new THREE.MeshBasicMaterial({ map: headTex, transparent: true, depthWrite: false })), 0, .29, .076);
    g.userData.refreshDate = () => { paint(); paintHead(); texture.needsUpdate = true; headTex.needsUpdate = true; };
  } else if (kind === 'messages' || kind === 'mail') {
    if (kind === 'messages') {
      add(g, slab(.73, .60, .12, color), -.12, .15, -.05);
      add(g, polygon([[-.37, -.1], [-.37, -.34], [-.13, -.1]], .08, color));
      add(g, slab(.76, .59, .09, 0xe2a8ff, { glass: true }), .12, -.04, .14);
      [-.10, .12, .34].forEach(x => add(g, ball(.045, white), x, -.03, .24));
    } else {
      add(g, slab(.57, .7, .10, color), 0, .18, 0);
      [.29, .15, .01].forEach(y => line(0, y, .32, .08));
      add(g, slab(.92, .52, .10, 0xb9dcff, { glass: true }), 0, -.22, .17);
      add(g, polygon([[-.44, .0], [0, -.29], [.44, .0]], .035, 0xe7f5ff), 0, -.07, .24);
    }
  } else if (kind === 'gallery') {
    add(g, slab(.88, .81, .10, color), 0, 0, 0); add(g, ball(.105, 0xffe790), -.25, .22, .09);
    add(g, polygon([[-.43, -.32], [-.15, .02], [.02, -.14], [.22, .2], [.43, -.32]], .08, 0x83efbe), 0, -.06, .12);
  } else if (kind === 'data') {
    const geo = cached(geometries, 'chart:pie', () => new THREE.CylinderGeometry(.4, .4, .10, 28, 1, false, Math.PI / 2, Math.PI * 1.5));
    add(g, new THREE.Mesh(geo, lightMaterial(color)), 0, -.06, 0).rotation.x = Math.PI / 2;
    const wedge = cached(geometries, 'chart:wedge', () => new THREE.CylinderGeometry(.4, .4, .08, 12, 1, false, 0, Math.PI / 2));
    add(g, new THREE.Mesh(wedge, lightMaterial(0xccffdc, true)), .08, .03, .12).rotation.x = Math.PI / 2;
  } else if (kind === 'search') {
    add(g, tube(.27, .075, color), -.09, .10, .06);
    add(g, ball(.235, 0xc5e4ff, true), -.09, .10, .025).scale.z = .24;
    add(g, slab(.12, .4, .12, color), .21, -.23, .04).rotation.z = Math.PI / 4;
    add(g, slab(.66, .23, .07, white, { glass: true }), -.15, -.25, .18);
  } else if (kind === 'agents') {
    add(g, slab(.77, .70, .13, color), .11, .03, -.02);
    add(g, ball(.16, 0xe5ebff, true), -.24, .24, .12);
    add(g, slab(.43, .34, .12, 0xd3e6ff, { glass: true }), -.25, -.13, .13);
    [.16, 0, -.16].forEach(y => line(.2, y, .27, .07));
  } else if (kind === 'eye') {
    // Œil : amande blanche, iris coloré, pupille sombre, reflet.
    const white_ = add(g, ball(.42, white), 0, 0, -.02); white_.scale.set(1.15, .62, .45);
    add(g, ball(.2, color), 0, 0, .12).scale.z = .5;
    add(g, ball(.1, 0x1b2236), 0, 0, .2).scale.z = .4;
    add(g, ball(.035, white), .06, .06, .25);
  } else if (kind === 'speaker') {
    add(g, slab(.26, .36, .2, color), -.22, 0, 0);
    add(g, polygon([[-.1, -.17], [.12, -.36], [.12, .36], [-.1, .17]], .2, color));
    [.2, .34].forEach((r, i) => { const t = add(g, tube(r, .035, white, Math.PI * .7), .1, 0, .02); t.rotation.z = -Math.PI * .35; });
  } else if (kind === 'tools') {
    // Clé plate croisée avec un tournevis.
    const w1 = add(g, slab(.16, .8, .1, color), 0, 0, 0); w1.rotation.z = Math.PI / 4;
    const head = add(g, tube(.15, .055, color, Math.PI * 1.5), -.27, .27, 0); head.rotation.z = -Math.PI * .1;
    const sd = add(g, slab(.09, .5, .08, 0xd9dee8), .1, .1, .07); sd.rotation.z = -Math.PI / 4;
    const hd = add(g, slab(.17, .32, .14, 0x5ab0ff), -.18, -.18, .08); hd.rotation.z = -Math.PI / 4;
  } else if (kind === 'brain') {
    [[-.18, .1, .24], [.18, .1, .24], [-.22, -.14, .2], [.22, -.14, .2], [0, .22, .22], [0, -.06, .26]].forEach(([x, y, r]) => add(g, ball(r, color), x, y, 0).scale.z = .6);
    add(g, slab(.03, .6, .06, 0xc94b86), 0, .02, .17);
  } else if (kind === 'target') {
    [.4, .27].forEach(r => add(g, tube(r, .045, r > .3 ? color : white), 0, 0, 0));
    add(g, ball(.12, color), 0, 0, .04);
    [[0, .5], [0, -.5], [.5, 0], [-.5, 0]].forEach(([x, y]) => add(g, slab(x ? .16 : .05, y ? .16 : .05, .05, white), x * .95, y * .95, 0));
  } else if (kind === 'sun') {
    add(g, ball(.27, color), 0, 0, 0).scale.z = .55;
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, r = add(g, slab(.07, .17, .06, 0xffd36e), Math.cos(a) * .42, Math.sin(a) * .42, 0); r.rotation.z = a - Math.PI / 2; }
    add(g, slab(.9, .06, .05, 0xff8a5c), 0, -.48, .05);
  } else if (kind === 'shelves') {
    // Étagère : trois planches et des boîtes rangées (≠ dossier).
    [-.3, .02, .34].forEach(y => add(g, slab(.92, .07, .3, color), 0, y, 0));
    [[-.26, -.15, .2, .24, 0xffd36e], [.04, -.17, .16, .2, 0x7fb6ff], [.3, -.14, .18, .26, 0xff8a7a], [-.18, .18, .26, .22, 0x9be6b4], [.22, .17, .2, .2, 0xc9a2ff]]
      .forEach(([x, y, w, hh, c]) => add(g, slab(w, hh, .2, c), x, y, .02));
  } else if (kind === 'weather') {
    add(g, ball(.25, color), .17, .21, -.07);
    [[-.27, -.02, .23], [0, .02, .29], [.27, -.05, .18]].forEach(([x,y,r]) => add(g, ball(r, white, true), x, y, .1));
  } else if (kind === 'mic') {
    add(g, slab(.29, .60, .15, color), 0, .12, .03);
    add(g, tube(.30, .04, white, Math.PI), 0, .08, .05).rotation.z = Math.PI;
    add(g, slab(.055, .24, .04, white), 0, -.33, .05); add(g, slab(.34, .05, .04, white), 0, -.43, .05);
  } else if (kind === 'screen' || kind === 'keyboard') {
    add(g, slab(.98, kind === 'screen' ? .66 : .51, .11, color), 0, .04, 0);
    add(g, slab(.85, kind === 'screen' ? .52 : .40, .035, 0xd7edff, { glass: true }), 0, .04, .075);
    if (kind === 'keyboard') for (let i = 0; i < 15; i++) add(g, slab(.10, .06, .018, white), (i % 5 - 2) * .15, .15 - Math.floor(i / 5) * .12, .11);
    else { add(g, slab(.07, .23, .05, color), 0, -.39); add(g, slab(.39, .055, .09, color), 0, -.49); }
  } else if (kind === 'shield') {
    add(g, polygon([[-.37,.28],[0,.43],[.37,.28],[.29,-.17],[0,-.42],[-.29,-.17]], .13, color));
    add(g, tube(.15, .025, white), -.19, -.23, .16);
    add(g, slab(.07,.16,.03,white), -.23,-.24,.19).rotation.z = .75;
    add(g, slab(.07,.25,.03,white), -.13,-.19,.19).rotation.z = -.65;
  } else if (kind === 'settings') {
    add(g, tube(.29,.11,color)); add(g, ball(.12,white,true),0,0,.07);
    for(let i=0;i<8;i++) { const a=i*Math.PI/4; add(g, slab(.14,.22,.13,color),Math.sin(a)*.36,Math.cos(a)*.36).rotation.z=-a; }
  } else if (kind === 'focus') {
    add(g, tube(.32,.055,color)); add(g, ball(.17,white,true),0,0,.06); add(g, ball(.075,color),0,0,.12);
  } else {
    for(let i=0;i<4;i++) add(g, slab(.37,.37,.12,color,{glass:i===3}), (i%2-.5)*.46, (.5-Math.floor(i/2))*.46, i===3?.12:0);
    add(g, slab(.055,.21,.025,white),.23,-.23,.20); add(g, slab(.21,.055,.025,white),.23,-.23,.20);
  }
  return g;
}

// Every dock icon uses shallow colored shapes and separate glass shapes.
export const DOCK_ICON_KINDS = ['mic','messages','folder','agents','sun','eye','speaker','calendar','documents','mail','search','data','gallery','apps','tools','brain','screen','keyboard','shelves','focus','target','refresh','settings'];
export function createDockIcon(kind) {
  kind=DOCK_ICON_KINDS.includes(kind)?kind:iconKind(kind);
  if(!DOCK_ICON_KINDS.includes(kind)) kind='apps';
  const g=new THREE.Group();g.userData.iconKind=kind;
  const white=0xf7fbff,blue=0x2388ff,purple=0xa932ee,green=0x20d590,orange=0xff8b1c,pink=0xf52d82;
  const plate=(w,h,c,x=0,y=0,z=0,glass=false,r=Math.min(w,h)*.22)=>{
    const mesh=add(g,slab(w,h,.018,c,{glass,radius:r}),x,y,z);
    mesh.userData.dockLayer=glass?'glass':c===white?'detail':'base';return mesh;
  };
  const shape=(path,c,x=0,y=0,z=0,glass=false)=>{
    const geo=new THREE.ExtrudeGeometry(path,{depth:.014,bevelEnabled:true,bevelSize:.008,bevelThickness:.004,bevelSegments:2,curveSegments:24,steps:1});
    geo.translate(0,0,-.007);const mesh=add(g,new THREE.Mesh(geo,lightMaterial(c,glass)),x,y,z);
    mesh.userData.dockLayer=glass?'glass':c===white?'detail':'base';return mesh;
  };
  const poly=(points,c,x=0,y=0,z=0,glass=false)=>shape(new THREE.Shape(points.map(p=>new THREE.Vector2(...p))),c,x,y,z,glass);
  const disc=(r,c,x=0,y=0,z=0,glass=false)=>{
    const path=new THREE.Shape();path.absarc(0,0,r,0,Math.PI*2,false);return shape(path,c,x,y,z,glass);
  };
  const ring=(r,t,c,x=0,y=0,z=0,glass=false)=>{
    const path=new THREE.Shape();path.absarc(0,0,r,0,Math.PI*2,false);
    const hole=new THREE.Path();hole.absarc(0,0,r-t,0,Math.PI*2,true);path.holes.push(hole);
    return shape(path,c,x,y,z,glass);
  };
  const cloud=(c,x=0,y=0,z=0,glass=true)=>{
    const path=new THREE.Shape();path.moveTo(-.34,-.15);path.bezierCurveTo(-.62,-.12,-.46,.37,-.18,.22);
    path.bezierCurveTo(-.11,.19,-.09,.11,-.08,.07);path.bezierCurveTo(.16,.29,.45,.13,.39,-.07);
    path.bezierCurveTo(.36,-.17,.26,-.19,.15,-.19);path.lineTo(-.34,-.19);
    return shape(path,c,x,y,z,glass);
  };
  const bubble=(c,x,y,z,glass=false)=>{
    plate(.70,.57,c,x,y,z,glass,.15);
    poly([[-.27,-.20],[-.27,-.38],[-.10,-.20]],c,x,y,z,glass);
  };
  const star=(r,c,x,y,z,glass=false)=>{
    const points=[];for(let i=0;i<10;i++){const a=Math.PI/2+i*Math.PI/5,rr=i%2?r*.46:r;points.push([Math.cos(a)*rr,Math.sin(a)*rr]);}
    return poly(points,c,x,y,z,glass);
  };
  if(kind==='folder'||kind==='shelves') {
    const path=new THREE.Shape();path.moveTo(-.44,-.25);path.lineTo(.44,-.25);path.lineTo(.44,.20);
    path.quadraticCurveTo(.44,.28,.36,.28);path.lineTo(-.02,.28);path.lineTo(-.20,.39);path.lineTo(-.36,.39);
    path.quadraticCurveTo(-.44,.39,-.44,.31);path.closePath();shape(path,blue,0,.03,0);
    plate(.94,.53,0xb4d6ff,-.025,-.12,.08,true,.12);
    if(kind==='shelves')[-.22,-.08,.06].forEach(y=>plate(.46,.036,white,-.025,y,.115));
  } else if(kind==='messages'||kind==='brain') {
    bubble(purple,-.12,.13,0);bubble(0xddaaff,.10,-.07,.08,true);
    if(kind==='brain')star(.17,white,.10,-.06,.115);
    else [-.09,.10,.29].forEach(x=>disc(.039,white,x,-.06,.115));
  } else if(kind==='documents') {
    plate(.62,.78,blue,.15,.10,0);plate(.67,.80,0xc2e4ff,-.10,-.08,.08,true);
    [.13,-.02,-.17].forEach(y=>plate(.42,.035,white,-.10,y,.115));plate(.23,.035,white,-.19,-.31,.115);
  } else if(kind==='mic') {
    plate(.29,.56,pink,0,.16,0,false,.145);
    const path=new THREE.Shape();path.moveTo(-.28,.07);path.lineTo(-.23,.07);path.lineTo(-.23,-.09);
    path.bezierCurveTo(-.23,-.36,.23,-.36,.23,-.09);path.lineTo(.23,.07);path.lineTo(.28,.07);path.lineTo(.28,-.09);
    path.bezierCurveTo(.28,-.43,-.28,-.43,-.28,-.09);path.closePath();shape(path,0xffbfd9,0,0,.08,true);
    plate(.05,.15,pink,0,-.37,0);plate(.35,.05,0xffbfd9,0,-.46,.08,true);
    plate(.19,.46,0xffbfd9,-.01,.15,.08,true,.095);
  } else if(kind==='sun') {
    disc(.25,0xffc500,.19,.22,0);cloud(0xfff0c8,-.025,-.06,.08);
  } else if(kind==='eye') {
    // Camera: clear visual identity for the Look action.
    plate(.79,.57,blue,.05,.04,0);plate(.23,.10,blue,-.20,.36,0);
    plate(.78,.53,0xc4e5ff,-.05,-.06,.08,true);
    ring(.17,.035,white,-.03,-.04,.115);disc(.09,blue,-.03,-.04,.116,true);
    plate(.10,.027,white,.23,.10,.115);
  } else if(kind==='speaker') {
    plate(.25,.72,purple,-.26,.01,0,false,.12);
    poly([[-.22,-.31],[.34,0],[-.22,.31]],0xb3ddff,0,0,.08,true);
    // Small white inner play triangle keeps the volume action recognizable.
    poly([[-.10,-.12],[.12,0],[-.10,.12]],white,-.01,0,.115);
  } else if(kind==='calendar') {
    plate(.81,.84,0xff3c25,0,.04,0);plate(.82,.65,0xffddd6,0,-.11,.08,true);
    [-.21,.21].forEach(x=>plate(.06,.19,white,x,.46,.115));
    const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
    const c=canvas.getContext('2d'),texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    const paint=()=>{const d=new Date();c.clearRect(0,0,256,256);c.textAlign='center';c.textBaseline='middle';
      c.fillStyle='#bf2821';c.font='600 40px sans-serif';c.fillText(d.toLocaleDateString(document.documentElement.lang==='en'?'en-GB':'fr-FR',{weekday:'short'}).replace('.',''),128,52);
      c.fillStyle='#182333';c.font='700 118px sans-serif';c.fillText(String(d.getDate()),128,161);texture.needsUpdate=true;};paint();
    add(g,new THREE.Mesh(new THREE.PlaneGeometry(.60,.60),new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false})),0,-.12,.12);
    g.userData.refreshDate=paint;
  } else if(kind==='mail') {
    plate(.58,.73,pink,0,.13,0);
    [.28,.15,.02].forEach(y=>plate(.34,.031,white,0,y,.025));
    plate(.88,.49,0xc4e9ff,0,-.23,.08,true);
    poly([[-.42,-.01],[0,-.26],[.42,-.01]],0xc4e9ff,0,-.01,.105,true);
  } else if(kind==='search') {
    ring(.29,.070,blue,-.08,.08,0);
    plate(.12,.36,blue,.24,-.25,0).rotation.z=Math.PI/4;
    disc(.215,0xc0e3ff,-.08,.08,.08,true);
    plate(.58,.22,0xe2f0ff,-.19,-.24,.10,true,.09);
    [-.33,-.19,-.05].forEach(x=>disc(.026,white,x,-.24,.125));
  } else if(kind==='focus') {
    // Focus = crescent moon with a glass cloud, no lens or handle.
    const path=new THREE.Shape();path.moveTo(.16,.35);path.bezierCurveTo(-.42,.47,-.55,-.29,-.05,-.38);
    path.bezierCurveTo(.25,-.43,.42,-.24,.39,-.08);path.bezierCurveTo(.06,-.23,-.17,.09,.16,.35);path.closePath();
    shape(path,purple,.02,.02,0);cloud(0xd9c9ff,-.07,-.15,.08);star(.075,white,.26,.25,.09);
  } else if(kind==='target') {
    // Recenter = four framing corners and a centered glass cross.
    for(const [x,y] of [[-.31,-.31],[-.31,.31],[.31,-.31],[.31,.31]]){
      plate(.24,.075,blue,x-Math.sign(x)*.08,y,0);
      plate(.075,.24,blue,x,y-Math.sign(y)*.08,0);
    }
    plate(.51,.51,0xc2e5ff,0,0,.08,true,.14);
    plate(.22,.041,white,0,0,.115);plate(.041,.22,white,0,0,.115);
  } else if(kind==='data') {
    const path=new THREE.Shape();path.moveTo(0,0);path.lineTo(0,.41);path.absarc(0,0,.41,Math.PI/2,Math.PI*2,false);path.closePath();
    shape(path,green,-.035,-.03,0);
    const wedge=new THREE.Shape();wedge.moveTo(0,0);wedge.lineTo(0,.39);wedge.absarc(0,0,.39,Math.PI/2,0,true);wedge.closePath();
    shape(wedge,0xbbffcb,.035,.045,.08,true);
    // Frosted lower segment overlaps the colored chart.
    plate(.54,.23,0xc2ffdb,-.02,-.22,.08,true,.10);
  } else if(kind==='gallery') {
    plate(.83,.77,blue,0,.02,0);disc(.10,0xffd52e,-.23,.24,.025);
    poly([[-.43,-.34],[-.16,.03],[.02,-.13],[.23,.23],[.44,-.34]],0xabf7c4,0,-.055,.08,true);
  } else if(kind==='agents') {
    plate(.68,.71,0x673ee9,.12,.02,0);
    [.16,.02,-.12].forEach(y=>plate(.29,.034,white,.23,y,.025));
    disc(.16,0xd3d6ff,-.25,.24,.08,true);
    const path=new THREE.Shape();path.moveTo(-.24,-.15);path.bezierCurveTo(-.25,.26,.25,.26,.24,-.15);path.closePath();
    shape(path,0xd3d6ff,-.25,-.21,.08,true);
  } else if(kind==='screen') {
    plate(.85,.61,0xff5738,.08,.10,0);plate(.79,.57,0xffd0c2,-.09,-.04,.08,true);
    plate(.04,.17,0xff5738,.08,-.28,0);plate(.37,.045,0xffd0c2,.04,-.38,.08,true);
    plate(.28,.028,white,-.14,-.22,.115);
  } else if(kind==='keyboard') {
    plate(.88,.51,blue,.05,.06,0);plate(.88,.49,0xc4e6ff,-.05,-.07,.08,true);
    for(let i=0;i<12;i++)plate(.075,.047,white,(i%4-1.5)*.17-.05,.06-Math.floor(i/4)*.13,.115);
  } else if(kind==='apps'||kind==='tools') {
    plate(.70,.74,orange,.12,.08,0);
    const path=new THREE.Shape();path.moveTo(-.35,.26);path.quadraticCurveTo(-.35,.36,-.25,.36);path.lineTo(.25,.36);
    path.quadraticCurveTo(.35,.36,.35,.26);path.lineTo(.35,-.30);path.quadraticCurveTo(.35,-.43,.24,-.36);
    path.lineTo(0,-.26);path.lineTo(-.24,-.36);path.quadraticCurveTo(-.35,-.43,-.35,-.30);path.closePath();
    shape(path,0xffd8a4,-.10,-.09,.08,true);
    if(kind==='apps'){plate(.33,.065,white,-.10,-.05,.115);plate(.065,.33,white,-.10,-.05,.115);}
    else {plate(.38,.039,white,-.10,.08,.115);plate(.38,.039,white,-.10,-.13,.115);
      disc(.066,white,-.19,.08,.117);disc(.066,white,.01,-.13,.117);}
  } else if(kind==='refresh') {
    // Flat refresh arrow behind a frosted floating card.
    const path=new THREE.Shape();path.absarc(0,0,.34,.35,Math.PI*1.93,false);
    path.lineTo(.19,-.14);path.absarc(0,0,.23,Math.PI*1.93,.35,true);path.closePath();shape(path,blue,.03,.06,0);
    poly([[.17,.18],[.42,.21],[.34,-.02]],blue,.03,.06,0);
    plate(.55,.33,0xc4e4ff,-.11,-.22,.08,true,.12);
    plate(.24,.028,white,-.11,-.22,.115);
  } else if(kind==='settings') {
    plate(.65,.74,purple,.13,.06,0);plate(.66,.72,0xe2c2ff,-.10,-.08,.08,true);
    [-.24,-.04,.16].forEach((y,i)=>{plate(.44,.033,white,-.10,y,.115);disc(.055,white,i===1?.015:-.20,y,.12);});
  }
  return g;
}

// Bake the colored backing once per icon. Its blurred image is sampled by
// the front glass in icon coordinates, so the frost works in stereo without
// reading the headset framebuffer or adding a full-screen postprocess pass.
let frostRenderer;
export function createFrostedDockIcon(kind) {
  const icon=createDockIcon(kind), surfaces=[];
  icon.updateMatrixWorld(true);
  icon.traverse(o=>{
    if(!o.isMesh || o.material.map) return;
    const source=o.material, material=new THREE.MeshBasicMaterial({color:0xffffff,vertexColors:true});material.userData={baseColor:source.color.clone()};
    const glass=source.transparent;
    const geometry=o.geometry.clone();geometry.userData={};geometry.computeBoundingBox();
    const p=geometry.attributes.position, bounds=geometry.boundingBox, colors=[];
    const span=Math.max(.001,bounds.max.y-bounds.min.y);
    for(let i=0;i<p.count;i++){
      const t=(p.getY(i)-bounds.min.y)/span;
      const color=source.color.clone().lerp(new THREE.Color(0xffffff),.01+t*.11);
      colors.push(color.r,color.g,color.b);
    }
    geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
    material.color.set(0xffffff);material.vertexColors=true;
    
    
    if(!o.geometry.userData.xrShared) o.geometry.dispose();
    o.material=material;o.geometry=geometry;
    if(glass) surfaces.push(o);
  });
  if(!surfaces.length) return icon;
  if(!frostRenderer){
    frostRenderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
    frostRenderer.setSize(256,256);frostRenderer.setClearColor(0x000000,0);
  }
  const scene=new THREE.Scene(), camera=new THREE.OrthographicCamera(-.7,.7,.7,-.7,.1,10);
  camera.position.z=3;
  scene.add(new THREE.HemisphereLight(0xffffff,0xb5c1da,1.7));
  const key=new THREE.DirectionalLight(0xffffff,2);key.position.set(-2,4,5);scene.add(key);
  // Hide the glass while rendering its backing; textured labels stay sharp.
  for(const o of surfaces) o.visible=false;
  scene.add(icon);frostRenderer.render(scene,camera);scene.remove(icon);
  for(const o of surfaces) o.visible=true;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const ctx=canvas.getContext('2d');
  ctx.filter='blur(9px)';ctx.drawImage(frostRenderer.domElement,0,0);ctx.filter='none';
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  // Each surface owns a texture clone for normal instance disposal.
  for(const o of surfaces){
    const p=o.geometry.attributes.position, uv=[], point=new THREE.Vector3();
    o.updateMatrix();
    for(let i=0;i<p.count;i++){
      point.fromBufferAttribute(p,i).applyMatrix4(o.matrix);
      uv.push((point.x+.7)/1.4,(point.y+.7)/1.4);
    }
    o.geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    const map=texture.clone();map.needsUpdate=true;
    const tint=o.material.userData.baseColor.clone().lerp(new THREE.Color(0xffffff),.48);
    o.material.dispose();
    o.material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,
      uniforms:{backing:{value:map},tint:{value:tint}},
      vertexShader:`varying vec2 vUv;varying vec3 vNormal;void main(){vUv=uv;vNormal=normalize(normalMatrix*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader:`uniform sampler2D backing;uniform vec3 tint;varying vec2 vUv;varying vec3 vNormal;
        void main(){vec4 blurred=texture2D(backing,vUv);float rim=pow(1.-abs(vNormal.z),2.);
        float alpha=mix(.48,.98,blurred.a);vec3 color=mix(tint,blurred.rgb,.78*blurred.a);
        color=mix(color,vec3(1.),.10+rim*.58);gl_FragColor=vec4(color,min(1.,alpha+rim*.24));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        }`});
    // Expose the map for disposeDesign's ownership cleanup.
    o.material.map=map;
  }
  texture.dispose();return icon;
}

// A finite radial alpha texture gives contact shadows without shadow-map passes.
let shadowTexture;
export function contactShadow(width, depth) {
  if (!shadowTexture) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gradient = g.createRadialGradient(32,32,0,32,32,32);
    gradient.addColorStop(0,'rgba(20,31,67,.36)'); gradient.addColorStop(.4,'rgba(20,31,67,.20)'); gradient.addColorStop(1,'rgba(20,31,67,0)');
    g.fillStyle = gradient; g.fillRect(0,0,64,64); shadowTexture = new THREE.CanvasTexture(c); shadowTexture.userData.xrShared = true;
  }
  const m = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), m); mesh.rotation.x = -Math.PI / 2; return mesh;
}
export function labelMesh(text, width = .16, { color = '#f2f7ff', background = true } = {}) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 96;
  const g = c.getContext('2d');
  if(background) { g.fillStyle = 'rgba(20,28,49,.86)'; g.beginPath(); g.roundRect(4,4,504,88,30); g.fill(); }
  let size=38; g.font=`600 ${size}px sans-serif`; while(size>18 && g.measureText(text).width>470) g.font=`600 ${--size}px sans-serif`;
  g.textAlign='center'; g.textBaseline='middle'; g.fillStyle=color; g.fillText(text,256,49);
  const tex=new THREE.CanvasTexture(c); tex.colorSpace=THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(width,width*96/512),new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false}));
}
export function disposeDesign(object) {
  const seen = new Set();
  object.traverse(o => {
    if(o.geometry && !o.geometry.userData.xrShared && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    for(const m of [].concat(o.material || [])) if(!m.userData.xrShared && !seen.has(m)) {
      seen.add(m); if(m.map && !m.map.userData.xrShared && !seen.has(m.map)) { seen.add(m.map); m.map.dispose(); } m.dispose();
    }
  });
}
