import { validateActionArgs, LUMEN_ACTIONS } from "../graph/lumen-nodes.js";
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { executeAssistant, validateGraph } from './runtime.js';
export function createAssistantServer(graph, env=process.env, fetcher=fetch) {
  validateGraph(graph);
  const secret=env.EMBED_SECRET;
  if(!secret || Buffer.byteLength(secret)<32) throw new Error('EMBED_SECRET doit contenir au moins 32 octets aléatoires.');
  const origins=new Set((env.ALLOWED_ORIGINS||'').split(',').filter(Boolean).map(s=>new URL(s.trim()).origin));
  if(!origins.size || origins.has('null')) throw new Error('ALLOWED_ORIGINS requis.');
  const sessions=new Map();let active=0;
  const ttl=900, quota=100000;
  const sign=s=>createHmac('sha256',secret).update(s).digest('base64url');
  const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
  function prune(){for(const [id,s] of sessions) if(s.exp<=Date.now()) sessions.delete(id);}
  async function body(req){let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>20000) throw new Error('Corps trop volumineux.');parts.push(chunk);}return JSON.parse(Buffer.concat(parts).toString());}
  async function upstream(url, payload, key){const r=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{})},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000),redirect:'error'});if(!r.ok) throw new Error('Backend indisponible.');return r;}
  const server=http.createServer(async(req,res)=>{
    const origin=req.headers.origin;
    const path=new URL(req.url,'http://localhost').pathname;
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
    if(origin && !origins.has(origin)) return send(403,{error:'Origine refusée.'});
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');}
    if(req.method==='OPTIONS') {res.writeHead(204);return res.end();}
    if(req.method==='GET'&&path==='/widget.js'){res.writeHead(200,{'Content-Type':'text/javascript','X-Content-Type-Options':'nosniff'});return res.end(await readFile(new URL('./widget.js',import.meta.url)));}
    if(req.method!=='POST') return send(404,{error:'Route inconnue.'});
    try {
      prune();
      const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
      if(path==='/session'||path==='/sessions/revoke') {
        if(!equal(token,secret)) return send(401,{error:'Authentification serveur requise.'});
        const p=await body(req);
        if(path==='/sessions/revoke'){sessions.delete(p.sessionId);return send(200,{revoked:true});}
        if(!origins.has(p.origin)||sessions.size>=1000) return send(400,{error:'Origine ou capacité invalide.'});
        const id=randomBytes(24).toString('base64url'),exp=Date.now()+ttl*1000;
        sessions.set(id,{origin:p.origin,exp,history:[],used:0,requests:0,busy:false});
        return send(200,{token:`${id}.${sign(id)}`,sessionId:id,expiresAt:exp});
      }
      if(path!=='/chat') return send(404,{error:'Route inconnue.'});
      const [id,mac,...extra]=token.split('.'),session=sessions.get(id);
      if(extra.length||!session||!equal(mac,sign(id))||origin!==session.origin) return send(401,{error:'Session expirée ou invalide.'});
      if(active>=4||session.busy||session.requests>=30) return send(429,{error:'Limite de requêtes atteinte.'});
      const p=await body(req);
      if(typeof p.message!=='string'||!p.message.trim()||p.message.length>4000) return send(400,{error:'Message invalide (4000 caractères maximum).'});
      if(active>=4||session.busy||session.requests>=30) return send(429,{error:'Limite de requêtes atteinte.'});
      session.busy=true;session.requests++;active++;
      let charged=0;
      try {
        const response=await executeAssistant(graph,{message:p.message,history:session.history,
          chat:async(messages,c={},tools=[])=>{
            const max=Math.min(8192,Math.max(1,Number(c.maxTokens)||1024));
            const cost=Buffer.byteLength(JSON.stringify(messages))+Buffer.byteLength(JSON.stringify(tools))+max;
            if(session.used+cost>quota) throw new Error('Budget de jetons atteint.');
            session.used+=cost;charged+=cost;
            const engine = !c.backend || c.backend === 'auto' ? (env.DEFAULT_BACKEND || 'cloud') : c.backend;
            if (!['local','cloud','ollama','applefm'].includes(engine)) throw new Error('Moteur inconnu.');
            if (engine === 'ollama') {
              const model = c.model || env.OLLAMA_MODEL;
              if (!model) throw new Error('Modèle Ollama non configuré.');
              const r = await upstream(`${(env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/,'')}/api/chat`, { model, messages, stream: false, options: { num_predict: max }, ...(tools.length ? { tools } : {}) });
              const data = await r.json();
              if (!data.message) throw new Error('Réponse Ollama invalide.');
              return data.message;
            }
            const local = engine === 'local', apple = engine === 'applefm';
            const base = (apple ? (env.APPLEFM_API_URL || 'http://127.0.0.1:11437/v1') : local ? (env.LOCAL_API_URL || 'http://127.0.0.1:11435/v1') : env.MODEL_API_URL)?.replace(/\/$/,'');
            const model = c.model || (apple ? (env.APPLEFM_MODEL || 'apple-on-device') : local ? env.LOCAL_MODEL : env.MODEL_NAME);
            if (!base || !model || (!local && !apple && !env.MODEL_API_KEY)) throw new Error('Modèle non configuré.');
            const r = await upstream(`${base}/chat/completions`, { model, messages, max_tokens: max, stream: false, ...(tools.length ? { tools } : {}) }, local || apple ? undefined : env.MODEL_API_KEY);
            const data = await r.json();
            if (!data.choices?.[0]?.message) throw new Error('Réponse du modèle invalide.');
            return data.choices[0].message;
          },
          lumen:async(action,args)=>{
            validateActionArgs(action,args);
            if(LUMEN_ACTIONS[action].write && env.LUMEN_ALLOW_WRITES !== 'true') throw new Error('Écritures désactivées pour cet assistant.');
            if(!graph.nodes.some(n=>n.type===`lumen_${action}`)||!env.LUMEN_DEVICE_TOKEN) throw new Error('Action non autorisée.');
            const r=await upstream(`${(env.LUMEN_URL||'http://127.0.0.1:8766').replace(/\/$/,'')}/device/nodal`,{name:action,args},env.LUMEN_DEVICE_TOKEN);
            return r.text();
          },
          fluxo:async(name,input)=>{
            // Only immutable exported workflow names can be invoked, never client overrides.
            const allowed=graph.nodes.some(n=>['fluxo_tool','fluxo_run'].includes(n.type)&&n.widgets?.workflow===name);
            if(!allowed||!env.LUMEN_DEVICE_TOKEN) throw new Error('Workflow non autorisé.');
            const r=await upstream(`${(env.LUMEN_URL||'http://127.0.0.1:8766').replace(/\/$/,'')}/device/workflow`,{name,input},env.LUMEN_DEVICE_TOKEN);
            return r.text();
          }
        });
        session.history.push({role:'user',content:p.message},{role:'assistant',content:response.slice(0,12000)});session.history=session.history.slice(-12);
        send(200,{response,usage:{reservedTokens:charged,remainingBudget:quota-session.used}});
      } finally {session.busy=false;active--;}
    } catch(e) {send(400,{error: e.message==='Budget de jetons atteint.'?e.message:'Requête impossible. Vérifiez le workflow et la configuration du serveur.'});}
  });
  server.requestTimeout=65000;server.headersTimeout=10000;
  return server;
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){
  const graph=JSON.parse(await readFile(new URL('./workflow.json',import.meta.url)));
  createAssistantServer(graph).listen(Number(process.env.PORT)||8787,process.env.HOST||'127.0.0.1',()=>console.log('Assistant prêt. Publiez derrière un reverse proxy HTTPS.'));
}
