// Lanceur de mini-apps confinées. Une app = un fichier HTML de la sandbox,
// éventuellement accompagné de CSS/JS/images. On « bundle » tout en un seul
// document autonome (assets inlinés en <style>/<script>/data:) puis on l'exécute
// dans une <iframe sandbox> avec une CSP stricte :
//   - aucune ressource réseau (default-src 'none', connect-src 'none') ;
//   - aucun accès au parent, au stockage, aux cookies ;
//   - seuls les assets de la sandbox, inlinés ici, sont disponibles.
// L'app ne peut donc rien lire/écrire hors d'elle-même ni appeler l'extérieur.

// `__TAURI__` vit sur la fenêtre parente quand ce module est importé depuis une
// iframe même-origine (ex. l'Éditeur de code ouvert via openAppFrame) : on
// retombe dessus, sinon `invoke` serait indéfini et le bundling échouerait.
const invoke = (window.__TAURI__ || window.parent?.__TAURI__)?.core?.invoke;

// Script injecté dans chaque app lancée : redirige console.* + erreurs vers le
// parent (panneau Console du runner) par postMessage. Sérialise sobrement les
// arguments sans casser si un objet est circulaire.
const CONSOLE_BRIDGE = `(function(){
  try{
    var ok=false;
    try{var k='__lumen_storage_probe__';window.localStorage.setItem(k,'1');window.localStorage.removeItem(k);ok=true;}catch(e){}
    if(!ok){
      var mem={};
      Object.defineProperty(window,'localStorage',{configurable:true,value:{
        getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:null;},
        setItem:function(k,v){mem[String(k)]=String(v);},
        removeItem:function(k){delete mem[String(k)];},
        clear:function(){mem={};},
        key:function(i){return Object.keys(mem)[i]||null;},
        get length(){return Object.keys(mem).length;}
      }});
    }
  }catch(e){}
  var clean=function(s){return String(s||'').replace(/^lumen-sandbox:\\/\\//,'');};
  var seen=[];
  var fmt=function(a){
    try{
      if(typeof a==='string')return a;
      if(a instanceof Error)return a.message||String(a);
      if(a&&typeof a==='object'){
        var cache=[];
        return JSON.stringify(a,function(k,v){if(typeof v==='function')return '[Function]';if(v&&typeof v==='object'){if(cache.indexOf(v)>=0)return '[Circular]';cache.push(v);}return v;},2);
      }
      return String(a);
    }catch(e){return String(a);}
  };
  var errInfo=function(e){
    if(!e)return {};
    return {
      name:e.name||'Error',
      message:e.message||String(e),
      stack:e.stack||'',
      source:e.fileName||'',
      line:e.lineNumber||0,
      column:e.columnNumber||0
    };
  };
  var send=function(level,args,extra){
    try{
      var payload=extra||{};
      var text=[].map.call(args||[],fmt).join(' ');
      parent.postMessage({
        __sbConsole:1,
        level:level,
        text:text,
        stack:payload.stack||'',
        source:clean(payload.source||payload.filename||''),
        line:payload.line||payload.lineno||0,
        column:payload.column||payload.colno||0,
        kind:payload.kind||'console',
        time:Date.now()
      },'*');
    }catch(e){}
  };
  window.__lumenRunScript=function(name,code){
    try{
      (0,eval)(String(code||'')+'\\n//# sourceURL='+clean(name||'app.js'));
    }catch(e){
      var info=errInfo(e);
      send('error',[info.name+': '+info.message],{kind:'script',stack:info.stack,source:name,line:info.line,column:info.column});
    }
  };
  var wrap=function(fn,label){
    if(typeof fn!=='function'||fn.__lumenWrapped)return fn;
    var w=function(){
      try{return fn.apply(this,arguments);}
      catch(e){
        var info=errInfo(e);
        send('error',[info.name+': '+info.message],{kind:label||'callback',stack:info.stack,source:info.source,line:info.line,column:info.column});
      }
    };
    try{Object.defineProperty(w,'__lumenWrapped',{value:true});}catch(e){}
    return w;
  };
  try{
    var add=EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener=function(type,listener,opts){return add.call(this,type,wrap(listener,'event:'+type),opts);};
    var st=window.setTimeout, si=window.setInterval, raf=window.requestAnimationFrame;
    window.setTimeout=function(fn){arguments[0]=wrap(fn,'setTimeout');return st.apply(this,arguments);};
    window.setInterval=function(fn){arguments[0]=wrap(fn,'setInterval');return si.apply(this,arguments);};
    if(raf)window.requestAnimationFrame=function(fn){return raf.call(this,wrap(fn,'requestAnimationFrame'));};
  }catch(e){}
  ['log','info','warn','error','debug'].forEach(function(m){
    var orig=(console[m]||function(){}).bind(console);
    console[m]=function(){send(m,arguments);orig.apply(null,arguments);};
  });
  window.addEventListener('error',function(e){
    if(e.message){
      var info=errInfo(e.error);
      send('error',[e.message],{kind:'runtime',stack:info.stack,source:e.filename||info.source,line:e.lineno||info.line,column:e.colno||info.column});
    }
    else if(e.target){
      var src=e.target.currentSrc||e.target.src||e.target.href||'';
      var tag=(e.target.tagName||'ressource').toLowerCase();
      send('error',['Échec de chargement '+tag+(src?': '+src:'')],{kind:'resource',source:src});
    }
  },true);
  window.addEventListener('unhandledrejection',function(e){
    var r=e.reason, info=errInfo(r);
    send('error',['Promesse rejetée : '+((r&&r.message)?r.message:fmt(r))],{kind:'promise',stack:info.stack,source:info.source,line:info.line,column:info.column});
  });
  send('info',['▶ App démarrée']);
})();`;

// Client « Bases de données » injecté dans chaque app confinée : expose
// `window.lumen.tables.*` qui dialogue avec le runner parent par postMessage RPC
// (le parent relaie vers les commandes Tauri `table_*`). La lecture est toujours
// permise ; l'écriture est refusée côté parent tant que l'app n'a pas l'accès
// écriture (cf. sandbox/main.js). L'app reste sinon totalement confinée.
const TABLES_BRIDGE = `(function(){
  window.lumen = window.lumen || {};
  var seq=0, pending={};
  window.addEventListener('message', function(e){
    var d=e.data;
    if(!d||!d.__lumenRpcReply)return;
    var p=pending[d.id]; if(!p)return; delete pending[d.id];
    if(d.ok)p.resolve(d.data); else p.reject(new Error(d.error||'Erreur base de données'));
  });
  function call(method, params){
    return new Promise(function(resolve,reject){
      var id=++seq; pending[id]={resolve:resolve,reject:reject};
      parent.postMessage({__lumenRpc:1, id:id, method:method, params:params||{}}, '*');
      setTimeout(function(){ if(pending[id]){delete pending[id]; reject(new Error('Délai dépassé (base de données)'));} }, 15000);
    });
  }
  window.lumen.tables = {
    listBases:function(){return call('table_base_list');},
    listTables:function(baseId){return call('table_list',{baseId:baseId});},
    schema:function(tableId){return call('table_schema',{tableId:tableId});},
    baseSchema:function(baseId){return call('table_base_schema',{baseId:baseId});},
    rows:function(tableId,limit,offset){return call('table_rows',{tableId:tableId,limit:limit,offset:offset});},
    query:function(baseId,sql){return call('table_query',{baseId:baseId,sql:sql});},
    exportCsv:function(tableId){return call('table_export_csv',{tableId:tableId});},
    createBase:function(name){return call('table_base_create',{name:name});},
    createTable:function(baseId,name,columns){return call('table_create',{baseId:baseId,name:name,columns:columns});},
    addColumn:function(tableId,name,colType){return call('table_column_add',{tableId:tableId,name:name,colType:colType});},
    insertRow:function(tableId,values){return call('table_row_insert',{tableId:tableId,values:values});},
    updateRow:function(tableId,rowId,values){return call('table_row_update',{tableId:tableId,rowId:rowId,values:values});},
    deleteRow:function(tableId,rowId){return call('table_row_delete',{tableId:tableId,rowId:rowId});}
  };
  // Interop : une mini-app confinée peut proposer un contenu au reste de Lumen.
  // Aucune permission n'est nécessaire parce que rien ne part sans que
  // l'UTILISATEUR ait choisi la destination dans le sélecteur du bureau — une
  // app hostile ne peut donc pas écrire ailleurs toute seule.
  // Ex. : window.lumen.share('table', { title:'Ventes', columns:[…], rows:[…] })
  window.lumen.share = function(kind, payload){
    return call('lumen_share', { kind: kind, payload: payload || {} });
  };
  // Lecture de l'étagère (presse-papier universel) : permet à une app de
  // proposer « reprendre ce que je viens de mettre de côté ».
  window.lumen.shelf = function(){ return call('lumen_shelf'); };
})();`;

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm",
};
function mimeOf(path) {
  const ext = path.split(".").pop().toLowerCase();
  return MIME[ext] || "application/octet-stream";
}
function isExternal(ref) { return /^(https?:|data:|blob:|#|mailto:|\/\/)/i.test(ref || ""); }
function sourceUrl(path) {
  return "\n//# sourceURL=" + String(path || "inline-script").replace(/[\s"'\\]/g, "_");
}
function jsLiteral(value) {
  return JSON.stringify(String(value ?? ""))
    .replace(/<\/script/gi, "<\\/script")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
function runnerScript(path, code) {
  return `window.__lumenRunScript(${jsLiteral(path)},${jsLiteral(code)});`;
}

// Normalise un chemin relatif (gère ./ et ../) à partir du dossier de base.
function resolvePath(baseDir, ref) {
  const clean = ref.split(/[?#]/)[0];
  const parts = (baseDir ? baseDir.split("/") : []).concat(clean.split("/"));
  const stack = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return stack.join("/");
}

// `overrides` (chemin -> contenu) permet à l'éditeur de prévisualiser le contenu
// NON SAUVEGARDÉ du fichier en cours d'édition sans l'écrire sur le disque.
async function readText(id, path, overrides) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, path)) return overrides[path];
  const f = await invoke("sandbox_read_file", { id, path }).catch(() => null);
  return f && !f.binary ? f.content : null;
}
async function readDataUrl(id, path) {
  const b64 = await invoke("sandbox_read_b64", { id, path }).catch(() => null);
  return b64 != null ? `data:${mimeOf(path)};base64,${b64}` : null;
}

// Inline les url(...) d'une feuille de style (images, polices) en data:.
async function inlineCssUrls(id, baseDir, css) {
  const refs = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]);
  for (const ref of new Set(refs)) {
    if (isExternal(ref)) continue;
    const data = await readDataUrl(id, resolvePath(baseDir, ref));
    if (data) css = css.split(ref).join(data);
  }
  return css;
}

// Construit le document autonome à partir du fichier HTML et de ses assets.
// `overrides` (chemin -> contenu) sert à l'aperçu de l'éditeur (fichiers non
// encore enregistrés). Voir readText().
export async function bundleApp(id, htmlPath, overrides = {}) {
  const html = await readText(id, htmlPath, overrides);
  if (html == null) throw new Error("HTML illisible");
  const baseDir = htmlPath.includes("/") ? htmlPath.slice(0, htmlPath.lastIndexOf("/")) : "";
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Feuilles de style : <link rel=stylesheet href> -> <style>.
  for (const link of [...doc.querySelectorAll('link[rel~="stylesheet"][href]')]) {
    const href = link.getAttribute("href");
    if (isExternal(href)) continue;
    let css = await readText(id, resolvePath(baseDir, href), overrides);
    if (css == null) continue;
    css = await inlineCssUrls(id, resolvePath(baseDir, href).split("/").slice(0, -1).join("/"), css);
    const style = doc.createElement("style");
    style.textContent = css;
    link.replaceWith(style);
  }
  // Styles inline existants : inline aussi leurs url().
  for (const style of [...doc.querySelectorAll("style")]) {
    style.textContent = await inlineCssUrls(id, baseDir, style.textContent || "");
  }
  // Scripts : <script src> -> script inline.
  for (const s of [...doc.querySelectorAll("script[src]")]) {
    const src = s.getAttribute("src");
    if (isExternal(src)) continue;
    const js = await readText(id, resolvePath(baseDir, src), overrides);
    if (js == null) continue;
    const inline = doc.createElement("script");
    const type = (s.type || "").trim().toLowerCase();
    if (type && type !== "text/javascript" && type !== "application/javascript") inline.type = s.type;
    inline.textContent = type === "module"
      ? js + sourceUrl(resolvePath(baseDir, src))
      : runnerScript(resolvePath(baseDir, src), js);
    inline.setAttribute("data-lumen-script", "external");
    s.replaceWith(inline);
  }
  // Scripts inline classiques : exécution via wrapper pour éviter les "Script error."
  // opaques de WKWebView et remonter la vraie stack dans la console Lumen.
  let inlineSeq = 0;
  for (const s of [...doc.querySelectorAll("script:not([src])")]) {
    if (s.getAttribute("data-lumen-script")) continue;
    const type = (s.type || "").trim().toLowerCase();
    if (type && type !== "text/javascript" && type !== "application/javascript") continue;
    const name = `${htmlPath}#inline-${++inlineSeq}`;
    s.textContent = runnerScript(name, s.textContent || "");
  }
  // Images / médias : src relatif -> data:.
  for (const el of [...doc.querySelectorAll("img[src],audio[src],video[src],source[src]")]) {
    const src = el.getAttribute("src");
    if (isExternal(src)) continue;
    const data = await readDataUrl(id, resolvePath(baseDir, src));
    if (data) el.setAttribute("src", data);
  }

  const head = doc.head || doc.documentElement;

  // Pont de console : capture console.* et les erreurs de l'app (iframe à origine
  // confinée) et les relaie au parent via postMessage. Inséré en premier pour
  // intercepter aussi les erreurs de chargement.
  const bridge = doc.createElement("script");
  bridge.textContent = CONSOLE_BRIDGE + sourceUrl("__lumen_console_bridge.js");
  head.insertBefore(bridge, head.firstChild);

  // Client « Bases de données » (window.lumen.tables) — inséré juste après le pont
  // console pour être disponible avant les scripts de l'app.
  const dbBridge = doc.createElement("script");
  dbBridge.textContent = TABLES_BRIDGE + sourceUrl("__lumen_tables_bridge.js");
  head.insertBefore(dbBridge, bridge.nextSibling);

  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}
