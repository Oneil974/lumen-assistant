// Spatial launcher, reading surfaces, search results and physical notifications.
import * as THREE from '/lib/three.module.js';
import { createSculptedIcon, createDockIcon, createFrostedDockIcon, iconKind, slab, labelMesh, disposeDesign } from '/xr-design.js';
import { markdownLines, drawMarkdownLine, THEME } from '/xr-panels.js';

export function createLightDesk(ctx) {
  const { world, Panel, addPanel, T, headPose, settings, props, apps, extras } = ctx;
  const root = new THREE.Group(); world.add(root);
  const dock = new THREE.Group(); root.add(dock); dock.visible=false;
  const controls=[], envelopes=[], transitions=new Map();
  let until=0, fade=0, page=0, lastDate='', reader=null, searchPanel=null;
  const reduceMotion = () => settings.reducedMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const local = p => { world.updateMatrixWorld(true); return world.worldToLocal(p.clone()); };
  function sound(at) {
    const ac=ctx.audio?.(); if(!ac) return;
    const oscillator=ac.createOscillator(), gain=ac.createGain();
    const position=at.getWorldPosition(new THREE.Vector3());
    const pan=new PannerNode(ac,{panningModel:'HRTF',positionX:position.x,positionY:position.y,positionZ:position.z,refDistance:.7});
    const t=ac.currentTime; oscillator.frequency.setValueAtTime(560,t); oscillator.frequency.exponentialRampToValueAtTime(900,t+.09);
    gain.gain.setValueAtTime(.035,t); gain.gain.exponentialRampToValueAtTime(.0001,t+.12);
    oscillator.connect(gain).connect(pan).connect(ac.destination); oscillator.start(); oscillator.stop(t+.13);
    oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();pan.disconnect();};
  }
  function control(parent, icon, label, at, size, onClick, id) {
    const holder=new THREE.Group(); holder.position.copy(at); parent.add(holder);
    const sculpture=createSculptedIcon(icon); sculpture.scale.setScalar(size); holder.add(sculpture);
    const title=labelMesh(label,size*1.48); title.position.set(0,-size*.74,.012); holder.add(title);
    const hit=new THREE.Mesh(new THREE.BoxGeometry(size*1.18,size*1.32,size*.60),new THREE.MeshBasicMaterial({visible:false})); holder.add(hit);
    const item={id,holder,sculpture,title,hit,onClick,size,hover:0,base:at.clone(),kind:'control',parent};
    hit.userData.spatialControl=item; controls.push(item); return item;
  }
  function alive(item) { let o=item.holder; while(o) {if(!o.visible) return false;o=o.parent;} return true; }
  const launcherIcons=new Map();
  function updateLauncher() {
    const panel=apps.launcher;if(!panel.visible)return;
    const tiles=apps.tiles(), W=panel.W,H=panel.H-panel.handleH,pad=26,gap=18,cols=tiles.length>4?3:2,rows=Math.ceil(tiles.length/cols);
    const tw=(W-pad*2-gap*(cols-1))/cols,th=(H-pad-gap*(rows-1)-10)/rows;
    for(const [i,tile] of tiles.entries()) {
      let icon=launcherIcons.get(tile.id);
      if(!icon){icon=createSculptedIcon(iconKind(tile.icon));panel.object.add(icon);launcherIcons.set(tile.id,icon);}
      const x=pad+(i%cols)*(tw+gap)+tw/2,y=10+Math.floor(i/cols)*(th+gap)+th/2-16+panel.handleH;
      icon.position.set(x/900-panel.width/2,panel.height/2-y/900,.018);icon.scale.setScalar(Math.min(.063,th/900*.43));
      icon.rotation.y=panel.hoverId===`tile:${tile.id}` ? .16 : 0;
    }
  }
  // Dock UNIFIÉ : il remplace l'ancienne barre de boutons. Fonctions de base
  // (parler, discussion, regarde, voix, réglages…) et apps sur la même rangée
  // d'icônes sculptées. `active` allume une pastille sous l'icône.
  const f = ctx.dockActions || {};
  function tiles() {
    return [
      {id:'talk',icon:'mic',label:f.listening?.()?T('Écoute…','Listening…'):T('Parler','Talk'),on:()=>f.talk?.(),active:()=>!!f.listening?.(),alert:true},
      {id:'chat',icon:'messages',label:T('Discussion','Chat'),on:()=>f.chat?.(),active:()=>!!f.chatOpen?.()},
      {id:'desk',icon:'folder',label:T('Fichiers','Files'),on:()=>props.show(true,{summon:true})},
      {id:'team',icon:'agents',label:T('Agents','Agents'),on:()=>props.openPicker?.(),active:()=>!!props.pickerOpen?.()},
      {id:'morning',icon:'sun',label:T('Matin','Morning'),on:()=>ctx.startMorning?.()},
      {id:'look',icon:'eye',label:T('Regarde','Look'),on:()=>f.look?.()},
      {id:'voice',icon:'speaker',label:f.voiceOn?.()?T('Voix','Voice'):T('Muet','Muted'),on:()=>f.voice?.(),active:()=>!!f.voiceOn?.()},
      {id:'calendar',icon:'calendar',label:T('Calendrier','Calendar'),on:()=>extras.openApp('calendar')},
      {id:'docs',icon:'documents',label:T('Documents','Documents'),on:()=>apps.openTile('docs')},
      {id:'notifs',icon:'mail',label:T('Messages','Messages'),on:()=>apps.openTile('notifs')},
      {id:'search',icon:'search',label:T('Rechercher','Search'),on:()=>search()},
      {id:'data',icon:'data',label:T('Données','Data'),on:()=>apps.openTile('data')},
      {id:'gallery',icon:'gallery',label:T('Galerie','Gallery'),on:()=>extras.openApp('photos')},
      {id:'apps',icon:'apps',label:T('Applications','Applications'),on:()=>extras.openApps()},
      {id:'tools',icon:'tools',label:T('Outils','Tools'),on:()=>f.tools?.()},
      {id:'ai',icon:'brain',label:T('Modèle IA','AI model'),on:()=>f.ai?.(),active:()=>!!f.aiOpen?.()},
      {id:'screen',icon:'screen',label:T('Écran','Screen'),on:()=>extras.openMirror()},
      {id:'keyboard',icon:'keyboard',label:T('Clavier','Keyboard'),on:()=>extras.openKeyboard()},
      {id:'shelves',icon:'shelves',label:T('Ranger','Arrange'),on:()=>{props.show(true);props.arrangeShelves();}},
      {id:'focus',icon:'focus',label:T('Focus','Focus'),on:()=>ctx.focus?.(),active:()=>!!f.focusOn?.()},
      {id:'center',icon:'target',label:T('Recentrer','Recenter'),on:()=>f.center?.()},
      {id:'refresh',icon:'refresh',label:T('Actualiser','Refresh'),on:()=>window.location.reload()},
      {id:'settings',icon:'settings',label:T('Réglages','Settings'),on:()=>ctx.openSettings?.(),active:()=>!!f.settingsOpen?.()},
    ];
  }
  const PER_PAGE=8, DOCK_STEP=.125, ICON=.058, rowW=(PER_PAGE-1)*DOCK_STEP;
  const panel=new THREE.Group(); dock.add(panel);
  // Fond : même verre sombre que les panneaux, dessiné sur canvas.
  function trayMesh(w,h){
    const px=1400,c=document.createElement('canvas');c.width=px;c.height=Math.round(px*h/w);
    const g=c.getContext('2d'),W=c.width,H=c.height,r=H*.38;
    g.beginPath();g.roundRect(4,4,W-8,H-8,r);
    const grad=g.createLinearGradient(0,0,0,H);grad.addColorStop(0,'rgba(64,68,86,0.92)');grad.addColorStop(.5,'rgba(26,28,38,0.9)');grad.addColorStop(1,'rgba(18,20,28,0.92)');
    g.fillStyle=grad;g.fill();g.lineWidth=3;g.strokeStyle='rgba(255,255,255,0.20)';g.stroke();
    g.save();g.clip();const sh=g.createLinearGradient(0,0,0,H*.3);sh.addColorStop(0,'rgba(255,255,255,0.14)');sh.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=sh;g.fillRect(0,0,W,H*.3);g.restore();
    const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;
    const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false}));m.renderOrder=-1;return m;
  }
  // Étagère discrète SOUS les icônes (posée à plat).
  const tray=trayMesh(rowW+.28,.07); tray.rotation.x=-Math.PI/2+.22; tray.position.set(0,-.036,-.012); panel.add(tray);
  // Pastille d'état (fonction active) sous chaque icône.
  const dotTex=(()=>{const c=document.createElement('canvas');c.width=c.height=32;const g=c.getContext('2d');const gr=g.createRadialGradient(16,16,2,16,16,16);gr.addColorStop(0,'rgba(255,255,255,1)');gr.addColorStop(.5,'rgba(255,255,255,.8)');gr.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=gr;g.fillRect(0,0,32,32);const t=new THREE.CanvasTexture(c);return t;})();
  const pageItems=[];
  for(let i=0;i<PER_PAGE;i++) {
    const item=control(panel,'apps','',new THREE.Vector3(-rowW/2+i*DOCK_STEP-.03,.01,0),ICON,()=>{},`dock:${i}`);
    const dot=new THREE.Mesh(new THREE.PlaneGeometry(.014,.014),new THREE.MeshBasicMaterial({map:dotTex,transparent:true,depthWrite:false,color:0xffffff}));
    dot.position.set(0,-.03,.03); dot.visible=false; item.holder.add(dot); item.dot=dot;
    pageItems.push(item);
  }
  // Page suivante : flèche (pastille de verre + chevron blanc).
  const next=control(panel,'apps','',new THREE.Vector3(rowW/2+.075,.01,0),.045,()=>{page=(page+1)%pages();refreshPage();},'dock:page');
  {
    const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('2d');
    g.beginPath();g.arc(64,64,58,0,Math.PI*2);g.fillStyle='rgba(255,255,255,0.12)';g.fill();g.lineWidth=2;g.strokeStyle='rgba(255,255,255,0.22)';g.stroke();
    g.strokeStyle='#f4f5f8';g.lineWidth=10;g.lineCap='round';g.lineJoin='round';g.beginPath();g.moveTo(54,38);g.lineTo(80,64);g.lineTo(54,90);g.stroke();
    const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;
    const arrow=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false}));
    next.holder.remove(next.sculpture,next.title);disposeDesign(next.sculpture);disposeDesign(next.title);
    next.sculpture=arrow;next.title=new THREE.Group();next.holder.add(arrow);arrow.scale.setScalar(next.size);
  }
  const dots=new THREE.Group(); dots.position.set(0,-.098,.03); panel.add(dots);
  const pages=()=>Math.ceil(tiles().length/PER_PAGE);
  let pageTiles=[];
  function refreshPage() {
    const all=tiles();
    pageTiles=[];
    pageItems.forEach((item,i)=>{
      const t=all[page*PER_PAGE+i]; item.holder.visible=!!t; pageTiles[i]=t; if(!t) return;
      item.holder.remove(item.sculpture,item.title); disposeDesign(item.sculpture);disposeDesign(item.title);
      item.sculpture=createFrostedDockIcon(t.icon); item.sculpture.scale.setScalar(ICON); item.holder.add(item.sculpture);
      item.title=labelMesh(t.label,.112); item.title.position.set(0,-.068,.03);item.holder.add(item.title); item.label=t.label;
      item.id=`dock:${t.id}`;
      item.onClick=()=>{const origin=item.holder.getWorldPosition(new THREE.Vector3());t.on();ctx.animateOpened?.(origin);setTimeout(refreshStates,120);};
    });
    for(const d of [...dots.children]){dots.remove(d);}
    const n=pages();
    for(let k=0;k<n;k++){const d=slab(.012,.012,.004,k===page?0xffffff:0x7f93b3,{radius:.006});d.position.x=(k-(n-1)/2)*.022;dots.add(d);}
  }
  /// Pastilles d'état et libellés changeants (Parler / Écoute…, Voix / Muet).
  function refreshStates(){
    const all=tiles();
    pageItems.forEach((item,i)=>{
      const cur=pageTiles[i]; if(!cur) return;
      const t=all.find(x=>x.id===cur.id); if(!t) return;
      const on=!!t.active?.(); item.dot.visible=on; item.dot.material.color.set(on&&t.alert?0xff4d6d:0xffffff);
      if(t.label!==item.label){item.holder.remove(item.title);disposeDesign(item.title);item.title=labelMesh(t.label,.112);item.title.position.set(0,-.068,.03);item.holder.add(item.title);item.label=t.label;}
    });
  }
  next.holder.visible=pages()>1;refreshPage();
  let attached=null;
  /// Rattache le dock à un objet (la barre) : il en suit les déplacements
  /// (poignée de la barre), sa visibilité et son inclinaison.
  function attach(obj, offset=new THREE.Vector3(0,.03,.02)){
    attached=obj; root.remove(dock); obj.add(dock); dock.position.copy(offset); dock.rotation.set(0,0,0);
    until=Infinity; dock.visible=true;
  }
  function show(at=null) {
    if(attached){until=Infinity;ctx.onDockChanged?.();return;}
    const pose=headPose(), fwd=new THREE.Vector3(0,0,-1).applyQuaternion(pose.quat);fwd.y=0;fwd.normalize();
    const target=at ? at.clone().addScaledVector(fwd,.28).add(new THREE.Vector3(0,.13,0)) : pose.pos.clone().addScaledVector(fwd,1.05).add(new THREE.Vector3(0,-.17,0));
    dock.position.copy(local(target));
    const head=local(pose.pos);dock.rotation.set(0,Math.atan2(head.x-dock.position.x,head.z-dock.position.z),0);
    until=Infinity;dock.visible=true;ctx.onDockChanged?.();
  }
  function setPinned(){}
  function animatePanel(panel,origin) {
    if(!panel?.visible || !origin || reduceMotion()) return;
    const destination=panel.object.position.clone(), end=panel.scale || 1;
    transitions.set(panel,{from:local(origin),to:destination,end,t0:performance.now()});
    panel.object.position.copy(local(origin)); panel.object.scale.setScalar(end*.12);
  }
  const reading={title:'',text:'',image:null,scroll:0,item:null,lines:0,view:1};
  function openDocument({title,text='',image=null,origin,item=null}) {
    reading.title=title;reading.text=String(text || '');reading.image=image;reading.scroll=0;reading.item=item;
    if(!reader) {
      reader=addPanel(new Panel({width:.74,height:.94,title:T('Lecture','Reader'),closable:true,draw(c,p){
        const W=p.W,H=p.H-p.handleH,pad=34,size=settings.textSize || 28,lh=size*1.38,viewH=H-130;
        c.fillStyle=settings.readingContrast===false?'rgba(19,28,49,.65)':'rgba(16,24,43,.96)';c.beginPath();c.roundRect(14,10,W-28,viewH-4,24);c.fill();
        c.save();c.beginPath();c.rect(pad,22,W-pad*2,viewH-28);c.clip();
        c.fillStyle=THEME.text;c.textAlign='left';c.textBaseline='top';c.font=`600 ${size+3}px ${THEME.font}`;
        const titleLines=reading.title ? markdownLines(c,`**${reading.title}**`,W-pad*2,size+3):[];
        const rows=[...titleLines,...(reading.image ? [] : markdownLines(c,reading.text || T('Aucun aperçu disponible.','No preview available.'),W-pad*2,size))];
        const imageHeight=reading.image ? Math.min(viewH-110,(W-pad*2)*reading.image.naturalHeight/reading.image.naturalWidth):0;
        reading.lines=rows.length+Math.ceil(imageHeight/lh);reading.view=Math.max(1,Math.floor((viewH-32)/lh));
        reading.scroll=Math.max(0,Math.min(reading.scroll,Math.max(0,reading.lines-reading.view)));
        rows.forEach((row,k)=>drawMarkdownLine(c,row,pad,24+(k-reading.scroll)*lh));
        if(reading.image){const iw=Math.min(W-pad*2,imageHeight*reading.image.naturalWidth/reading.image.naturalHeight);c.drawImage(reading.image,(W-iw)/2,24+(titleLines.length-reading.scroll)*lh,iw,imageHeight);}
        c.restore();
        const fy=H-108;
        p.iconButton('read:up',pad,fy,62,'',()=>p.onScroll(-reading.view+1),{icon:'chevron-up',inContent:true});
        p.iconButton('read:down',pad+76,fy,62,'',()=>p.onScroll(reading.view-1),{icon:'chevron-down',inContent:true});
        p.pill('read:send',W-250,fy,216,62,T('À Lumen','To Lumen'),()=>{
          if(reading.item){ctx.send({type:'attach-doc-ref',item:reading.item});ctx.toast(T('Document joint à la discussion','Document attached to the conversation'));}
          else ctx.sendChat(reading.text);
        },{active:true});
        c.font=`400 20px ${THEME.font}`;c.fillStyle=THEME.dim;c.textAlign='center';c.textBaseline='middle';
        c.fillText(`${Math.min(reading.lines,reading.scroll+reading.view)} / ${reading.lines}`,W/2,H-24);
      }}),new THREE.Vector3(.46,.12,-1),-.3,false,'light:reader');
      reader.onScroll=delta=>{reading.scroll=Math.max(0,Math.min(reading.scroll+delta,Math.max(0,reading.lines-reading.view)));reader.invalidate();};
    }
    ctx.openNear(reader);reader.invalidate();animatePanel(reader,origin);
  }
  function updateDocument({item,text,image}){
    if(!reader?.visible || reading.item?.sandboxId!==item?.sandboxId || reading.item?.path!==item?.path)return;
    reading.text=String(text || '');reading.image=image || null;reader.invalidate();
  }
  let results=[], query='', searching=false;
  function search() {
    props.show(true);
    if(!searchPanel) searchPanel=addPanel(new Panel({width:.64,height:.70,title:T('Recherche spatiale','Spatial search'),closable:true,draw(c,p){
      const W=p.W,H=p.H-p.handleH;
      c.font=`600 28px ${THEME.font}`;c.fillStyle=THEME.text;c.textAlign='left';c.textBaseline='top';
      c.fillText(searching?T('Recherche…','Searching…') : query ? `“${query}”` : T('Recherchez vos objets','Find your objects'),30,20);
      if(!results.length){c.font=`400 25px ${THEME.font}`;c.fillStyle=THEME.dim;c.fillText(query?T('Aucun objet trouvé','No objects found'):T('Noms des dossiers et fichiers ouverts','Folder names and open files'),30,82);}
      results.slice(0,5).forEach((prop,i)=>{
        const name=prop.data.entry?.name || prop.data.sandbox?.name || '';
        p.pill(`search:${prop.id}`,28,76+i*65,W-56,54,name,()=>{props.highlight([prop]);props.click(prop);});
      });
      p.pill('search:query',28,H-82,(W-68)/2,60,T('Dicter','Speak'),()=>askSearch(),{active:true});
      p.pill('search:type',40+(W-68)/2,H-82,(W-68)/2,60,T('Clavier','Keyboard'),()=>extras.inputText(T('Rechercher','Search'),query,runSearch));
    }}),new THREE.Vector3(.35,.1,-.9),-.3,false,'light:search');
    ctx.openNear(searchPanel);for(const item of controls)if(item.searchResult)item.holder.visible=true;
  }
  function askSearch(){ctx.dictate(T('Quel dossier ou fichier cherchez-vous ?','Which folder or file are you looking for?'),runSearch,{field:true});}
  function runSearch(text){
    query=String(text || '').trim();searching=true;searchPanel.invalidate();
    results=query?props.search(query):[];props.highlight(results);searching=false;searchPanel.invalidate();clearResultCards();
    results.slice(0,5).forEach((prop,i)=>{
      const base=searchPanel.object.getWorldPosition(new THREE.Vector3());
      const item=control(root,prop.kind==='folder'?'folder':'documents',prop.data.entry?.name || prop.data.sandbox?.name,new THREE.Vector3(),.06,()=>{props.highlight([prop]);props.click(prop);},`result:${prop.id}`);
      const right=new THREE.Vector3(1,0,0).applyQuaternion(headPose().quat);
      item.holder.position.copy(local(base.addScaledVector(right,(i-2)*.13).add(new THREE.Vector3(0,-.43,.04))));
      item.holder.quaternion.copy(searchPanel.object.quaternion);item.searchResult=true;
    });
  }
  function removeControl(item){const index=controls.indexOf(item);if(index>=0)controls.splice(index,1);item.parent.remove(item.holder);disposeDesign(item.holder);}
  function clearResultCards(){for(const item of [...controls])if(item.searchResult)removeControl(item);}
  function notify(notification) {
    if(!notification?.body && !notification?.title) return;
    while(envelopes.length>=4) removeControl(envelopes.shift());
    const pose=headPose(), target=pose.pos.clone().add(new THREE.Vector3(.48,-.05,-.85).applyQuaternion(pose.quat));
    const item=control(root,'mail',notification.title || T('Message','Message'),local(target),.075,()=>{
      openDocument({title:notification.title || T('Message','Message'),text:notification.body,origin:item.holder.getWorldPosition(new THREE.Vector3())});
      notification.seen=true;const index=envelopes.indexOf(item);if(index>=0)envelopes.splice(index,1);
      item.opening=performance.now();if(reduceMotion())removeControl(item);apps.panels.notifs.invalidate();ctx.onPanelsChanged?.();
    },`notification:${performance.now()}`);
    item.draggable=true;item.holder.lookAt(pose.pos);item.arrival=performance.now();envelopes.push(item);
    envelopes.forEach((e,i)=>{e.base.copy(local(target)).add(new THREE.Vector3(0,-i*.025,-i*.018));});
  }
  function nearest(point,radius=.06){return controls.filter(alive).find(item=>item.hit.getWorldPosition(new THREE.Vector3()).distanceTo(point)<radius) || null;}
  function click(item,pointer){if(!alive(item) || item.opening)return;ctx.haptic?.(pointer,.3,25);sound(item.holder);until=Math.max(until,performance.now()+3500);item.onClick?.();}
  function setHovered(list){const set=new Set(list);for(const item of controls){item.hover+=(Number(set.has(item))-item.hover)*.25;if(set.has(item)&&item.parent===panel)until=Math.max(until,performance.now()+4500);}}
  function tick(now,dt=.016) {
    updateLauncher();
    if(now-(tick._st||0)>250){tick._st=now;refreshStates();}
    const want=now<until && (!attached || attached.visible!==false);fade+=(Number(want)-fade)*Math.min(1,dt*8);dock.visible=fade>.015;
    if(dock.visible)dock.scale.setScalar(reduceMotion()?1:.8+fade*.2);
    const date=new Date().toDateString();if(date!==lastDate){lastDate=date;for(const item of controls)item.sculpture.userData.refreshDate?.();}
    for(const item of controls)if(alive(item)){
      const hover=item.hover;
      item.sculpture.position.y=reduceMotion()?0:hover*.012+Math.sin(now*.0015+item.base.x*10)*.0015;
      item.sculpture.rotation.y=reduceMotion()?0:hover*.12;
      item.sculpture.scale.setScalar(item.size*(1+hover*.10));
      if(item.opening){
        const k=Math.min(1,(now-item.opening)/420);
        if(item.sculpture.children[0])item.sculpture.children[0].position.y=.18+k*.42;
        item.sculpture.scale.setScalar(item.size*(1-k*.55));
        if(k===1){removeControl(item);continue;}
      }
      if(item.arrival){const k=Math.min(1,(now-item.arrival)/600);item.holder.position.copy(item.base).add(new THREE.Vector3((1-k)*.18,Math.sin(k*Math.PI)*.03,0));if(k>=1)item.arrival=0;}
      if(item.searchResult && !searchPanel?.visible)item.holder.visible=false;
    }
    for(const [panel,tr] of transitions){
      const k=Math.min(1,(now-tr.t0)/420),ease=1-Math.pow(1-k,3);
      panel.object.position.copy(tr.from).lerp(tr.to,ease);panel.object.scale.setScalar(tr.end*(.12+.88*ease));
      if(k===1 || !panel.visible)transitions.delete(panel);
    }
  }
  return {show,setPinned,attach,hideAll:(on)=>{root.visible=!on;},toggle:()=>{if(until>performance.now()){until=0;ctx.onDockChanged?.();}else show();},get visible(){return until>performance.now();},get attached(){return !!attached;},pickables:()=>controls.filter(alive).map(i=>i.hit),nearest,click,setHovered,tick,notify,openDocument,updateDocument,animatePanel,search,runSearch,
    debug:()=>({dock,controls,reader,reading,searchPanel,envelopes,transitions})};
}
