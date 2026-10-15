import { LUMEN_DEFS } from "../graph/lumen-nodes.js";
import { AI_DEFS } from '../graph/ai-nodes.js';
const port = (name, widget, optional = false) => ({ name, widget, optional });
export const PORTABLE_DEFS = Object.fromEntries([
  ...AI_DEFS, ...LUMEN_DEFS,
  { type:'text', widgets:[{name:'text',default:''}], outputs:[{}], run:(i,w)=>[w.text] },
  { type:'number', widgets:[{name:'value',default:1}], outputs:[{}], run:(i,w)=>[Number(w.value)] },
  { type:'concat', inputs:['a','b','c'].map(n=>port(n,null,true)), widgets:[{name:'sep',default:', '}], outputs:[{}], run:(i,w)=>[[i.a,i.b,i.c].filter(v=>v!=null&&v!=='').join(w.sep)] },
  { type:'template', inputs:['a','b','n'].map(n=>port(n,null,true)), outputs:[{}], run:(i,w)=>[String(w.tpl||'').replace(/\{(a|b|n)\}/g,(_,k)=>i[k]??'')] },
  { type:'llm_text', inputs:[port('consigne','prompt'),port('contexte',null,true)], outputs:[{}], run:async(i,w,c)=>[(await c.chat([{role:'system',content:i.contexte||'Tu es un assistant utile.'},...c.history,{role:'user',content:i.consigne}],w)).content||''] },
  { type:'json_parse', ...AI_DEFS.find(d=>d.type==='json_parse') },
].map(d=>[d.type,{inputs:[],outputs:[],widgets:[],...d}]));
// Seuls les blocs qui alimentent la Réponse assistant partent dans l'export :
// les Aperçus, notes et branches de test du canevas n'ont rien à faire sur le
// serveur (et n'y sont pas exécutables).
export function pruneForEmbed(graph) {
  const nodes=Array.isArray(graph?.nodes)?graph.nodes:[],links=Array.isArray(graph?.links)?graph.links:[];
  const outs=nodes.filter(n=>n.type==='chat_output');
  if(outs.length!==1) return graph;
  const keep=new Set([outs[0].id]);
  for(let changed=true;changed;){changed=false;for(const l of links) if(keep.has(l.to)&&!keep.has(l.from)){keep.add(l.from);changed=true;}}
  for(const n of nodes) if(n.type==='chat_input') keep.add(n.id);
  return {...graph,nodes:nodes.filter(n=>keep.has(n.id)),links:links.filter(l=>keep.has(l.from)&&keep.has(l.to))};
}
export function validateGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links) || graph.nodes.length > 100 || graph.links.length > 400) throw new Error('Graphe invalide (100 blocs maximum).');
  const ids = new Set();
  for (const n of graph.nodes) {
    if (!PORTABLE_DEFS[n.type]) throw new Error(`Bloc non exportable : ${n.type}. Utilisez les blocs assistant, Fluxo, JSON, texte ou modèle.`);
    if (typeof n.id !== 'string' || ids.has(n.id) || n.mode) throw new Error('Identifiant dupliqué ou bloc contourné/en sourdine.');
    ids.add(n.id);
  }
  if (graph.nodes.filter(n=>n.type==='chat_input').length !== 1 || graph.nodes.filter(n=>n.type==='chat_output').length !== 1) throw new Error('Il faut exactement une Entrée chat et une Réponse assistant.');
  const occupied = new Set();
  for (const l of graph.links) {
    const a=graph.nodes.find(n=>n.id===l.from),b=graph.nodes.find(n=>n.id===l.to);
    if (!a || !b || !Number.isInteger(l.in) || !Number.isInteger(l.out) || !PORTABLE_DEFS[a.type].outputs[l.out] || !PORTABLE_DEFS[b.type].inputs[l.in]) throw new Error('Lien invalide.');
    const p=`${l.to}:${l.in}`;
    if(occupied.has(p)) throw new Error('Plusieurs liens vers la même entrée.');
    occupied.add(p);
  }
  orderGraph(graph);
  const output=graph.nodes.find(n=>n.type==='chat_output');
  const ancestors=new Set([output.id]);
  for(let k=0;k<graph.nodes.length;k++) for(const l of graph.links) if(ancestors.has(l.to)) ancestors.add(l.from);
  if(!ancestors.has(graph.nodes.find(n=>n.type==='chat_input').id)) throw new Error('La réponse doit être connectée à l’entrée chat.');
  return graph;
}
function orderGraph(g) {
  const pending = [...g.nodes], done = new Set(), order=[];
  while(pending.length) {
    const k=pending.findIndex(n=>g.links.filter(l=>l.to===n.id).every(l=>done.has(l.from)));
    if(k<0) throw new Error('Boucle dans le graphe.');
    const [n]=pending.splice(k,1);done.add(n.id);order.push(n);
  }
  return order;
}
export async function executeAssistant(graph, ctx) {
  validateGraph(graph);
  const results=new Map();let response='';
  for(const n of orderGraph(graph)) {
    const d=PORTABLE_DEFS[n.type],w=Object.fromEntries(d.widgets.map(w=>[w.name,w.default??'']));Object.assign(w,n.widgets||{});
    const i={};
    for(const [k,p] of d.inputs.entries()) {
      const l=graph.links.find(l=>l.to===n.id&&l.in===k);
      i[p.name]=l ? results.get(l.from)?.[l.out] : p.widget ? w[p.widget] : undefined;
      if(i[p.name]==null&&!p.optional) throw new Error(`Entrée manquante : ${p.name}`);
    }
    const r=await d.run(i,w,ctx);results.set(n.id,r);
    if(n.type==='chat_output') response=String(r[0]??'');
  }
  return response;
}
