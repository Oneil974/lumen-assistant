import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createAssistantServer } from '../src/nodal/embed/server.mjs';
import { executeAssistant,validateGraph } from '../src/nodal/embed/runtime.js';
import { agentTurn } from '../src/nodal/graph/ai-nodes.js';
import { collectDependencies } from './frontend-dependencies.mjs';
const graph={nodes:[{id:'in',type:'chat_input'},{id:'model',type:'chat_model',widgets:{model:'test-model',backend:'cloud',maxTokens:100}},{id:'agent',type:'ai_agent',widgets:{}},{id:'out',type:'chat_output'}],links:[{from:'in',out:0,to:'agent',in:0},{from:'model',out:0,to:'agent',in:1},{from:'agent',out:0,to:'out',in:0}]};
test('portable graph applies model configuration and message',async()=>{
  let seen;
  const result=await executeAssistant(graph,{message:'bonjour',history:[],chat:async(messages,config)=>{seen={messages,config};return {content:'salut'};}});
  assert.equal(result,'salut');assert.equal(seen.config.model,'test-model');assert.equal(seen.messages.at(-1).content,'bonjour');
});
test('invalid graphs, unsupported blocks and cycles are rejected',()=>{
  assert.throws(()=>validateGraph({...graph,nodes:[...graph.nodes,{id:'bad',type:'image_gen'}]}),/non exportable/);
  assert.throws(()=>validateGraph({...graph,links:[]}),/connectée/);
  assert.throws(()=>validateGraph({...graph,links:[...graph.links,{from:'out',out:0,to:'agent',in:2}]}),/Boucle/);
});
test('tool calling runs only connected workflows and returns tool result to model',async()=>{
  const calls=[];let turns=0;
  const result=await agentTurn({message:'calcul',outil:{name:'calculate',workflow:'Calcul',description:'Calcule'}},{iterations:2},{chat:async(messages,config,tools)=>{assert.equal(tools[0].function.name,'calculate');return ++turns===1 ? {tool_calls:[{id:'c1',type:'function',function:{name:'calculate',arguments:'{"input":"2+2"}'}}]} : {content:messages.at(-1).content};},fluxo:async(...args)=>{calls.push(args);return '4';}});
  assert.equal(result[0],'4');assert.deepEqual(calls,[['Calcul','2+2']]);
  await assert.rejects(agentTurn({message:'x',outil:{name:'safe',workflow:'Safe'}},{},{chat:async()=>({tool_calls:[{function:{name:'unsafe',arguments:'{}'}}]})}),/non autorisé/);
});
test('server authenticates, isolates sessions, rejects origins and forged tokens, revokes',async t=>{
  const env={EMBED_SECRET:'a'.repeat(64),ALLOWED_ORIGINS:'https://site.example',MODEL_API_URL:'https://model.example/v1',MODEL_API_KEY:'private-key',MODEL_NAME:'default'};
  const bodies=[];
  const server=createAssistantServer(graph,env,async(url,init)=>{assert.equal(init.headers.Authorization,'Bearer private-key');const b=JSON.parse(init.body);bodies.push(b);return Response.json({choices:[{message:{content:`reply:${b.messages.at(-1).content}`}}]});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,token,p,origin)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(origin?{Origin:origin}:{})},body:JSON.stringify(p)});
  assert.equal((await post('/session','bad',{origin:'https://site.example'})).status,401);
  const mint=async()=>{const r=await post('/session',env.EMBED_SECRET,{origin:'https://site.example'});assert.equal(r.status,200);return r.json();};
  const a=await mint(),b=await mint();
  assert.equal((await post('/chat',a.token,{message:'x'},'https://evil.example')).status,403);
  assert.equal((await post('/chat',a.token+'x',{message:'x'},'https://site.example')).status,401);
  assert.equal((await post('/chat',a.token,{message:'x'})).status,401);
  let r=await post('/chat',a.token,{message:'one'},'https://site.example');assert.equal(r.status,200);assert.equal((await r.json()).response,'reply:one');
  await post('/chat',a.token,{message:'two'},'https://site.example');await post('/chat',b.token,{message:'three'},'https://site.example');
  assert.equal(bodies[1].messages.length,4);assert.equal(bodies[2].messages.length,2);assert.equal(bodies[0].model,'test-model');
  assert.equal((await post('/chat',a.token,{message:'x'.repeat(4001)},'https://site.example')).status,400);
  await post('/sessions/revoke',env.EMBED_SECRET,{sessionId:a.sessionId});assert.equal((await post('/chat',a.token,{message:'x'},'https://site.example')).status,401);
  const widget=await fetch(base+'/widget.js');assert.equal(widget.status,200);assert.ok(!(await widget.text()).includes(env.EMBED_SECRET));
});
test('export assets are included in packaged frontend',()=>{
 const result=collectDependencies(fileURLToPath(new URL('../src/',import.meta.url)),['nodal/nodal.html']);
 for(const name of ['nodal/embed/server.mjs','nodal/embed/widget.js','nodal/embed/runtime.js','nodal/graph/ai-nodes.js']) assert.ok(result.files.has(name),name);
});

test('explicit engines and Apple availability preserve saved selections', async () => {
  const { inferenceOptions } = await import('../src/nodal/graph/ai-nodes.js');
  const { explicitInferenceSource, assertAppleModel } = await import('../src/lib/inference-source.js');
  assert.equal(explicitInferenceSource('ollama'), 'ollama');
  assert.equal(explicitInferenceSource('applefm'), 'applefm');
  assert.equal(explicitInferenceSource('auto'), null);
  assert.ok(inferenceOptions(false).some(o => o.id === 'ollama'));
  assert.ok(!inferenceOptions(false).some(o => o.id === 'applefm'));
  assert.ok(inferenceOptions(true).some(o => o.id === 'applefm' && !o.disabled));
  assert.ok(inferenceOptions(false, 'applefm').find(o => o.id === 'applefm').disabled);
  assert.throws(() => assertAppleModel({ available: false, models: [] }), /indisponible/);
  const state = { available: true, models: [{ id: 'apple-on-device', available: true }, { id: 'apple-private-cloud', available: false }] };
  assert.equal(assertAppleModel(state, ''), 'apple-on-device');
  assert.throws(() => assertAppleModel(state, 'apple-private-cloud'), /indisponible/);
});

test('embed routes Ollama and Apple FM independently, without cloud keys or fallback', async t => {
  for (const backend of ['ollama', 'applefm']) await t.test(backend, async t => {
    const g = structuredClone(graph);
    g.nodes.find(n => n.id === 'model').widgets = { backend, model: backend === 'ollama' ? 'qwen-test' : 'apple-on-device', maxTokens: 150 };
    let calls = [];
    const server = createAssistantServer(g, { EMBED_SECRET: 'b'.repeat(64), ALLOWED_ORIGINS: 'https://site.example' }, async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return backend === 'ollama' ? Response.json({ message: { role: 'assistant', content: 'Ollama OK' } }) : Response.json({ choices: [{ message: { content: 'Apple OK' } }] });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const mint = await fetch(base + '/session', { method: 'POST', headers: { Authorization: 'Bearer ' + 'b'.repeat(64), 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'https://site.example' }) });
    const { token } = await mint.json();
    const r = await fetch(base + '/chat', { method: 'POST', headers: { Origin: 'https://site.example', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Bonjour' }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).response, backend === 'ollama' ? 'Ollama OK' : 'Apple OK');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.equal(calls[0].url, backend === 'ollama' ? 'http://127.0.0.1:11434/api/chat' : 'http://127.0.0.1:11437/v1/chat/completions');
    assert.equal(backend === 'ollama' ? calls[0].body.options.num_predict : calls[0].body.max_tokens, 150);
  });
});

test('exported Lumen actions use the authenticated bridge and deny writes by default',async t=>{
 const env={EMBED_SECRET:'b'.repeat(64),ALLOWED_ORIGINS:'https://site.example',LUMEN_URL:'http://127.0.0.1:8766',LUMEN_DEVICE_TOKEN:'server-only-device-token'};
 const run=async(type,allowWrites)=>{
  const g={nodes:[{id:'i',type:'chat_input'},{id:'tool',type},{id:'o',type:'chat_output'}],links:[{from:'i',out:0,to:'tool',in:0},{from:'tool',out:1,to:'o',in:0}]};
  const calls=[];const server=createAssistantServer(g,{...env,...(allowWrites?{LUMEN_ALLOW_WRITES:'true'}:{})},async(url,init)=>{calls.push({url,init});return new Response('Résultat Lumen');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}`;
  const minted=await fetch(base+'/session',{method:'POST',headers:{Authorization:`Bearer ${env.EMBED_SECRET}`,'Content-Type':'application/json'},body:JSON.stringify({origin:'https://site.example'})});const {token}=await minted.json();
  const r=await fetch(base+'/chat',{method:'POST',headers:{Authorization:`Bearer ${token}`,Origin:'https://site.example','Content-Type':'application/json'},body:JSON.stringify({message:'Saint-Denis'})});
  return {r,calls};
 };
 const read=await run('lumen_weather_now',false);assert.equal(read.r.status,200);assert.equal((await read.r.json()).response,'Résultat Lumen');assert.equal(read.calls[0].url,'http://127.0.0.1:8766/device/nodal');assert.equal(read.calls[0].init.headers.Authorization,`Bearer ${env.LUMEN_DEVICE_TOKEN}`);assert.equal(JSON.parse(read.calls[0].init.body).name,'weather_now');
 const denied=await run('lumen_memory_remember',false);assert.equal(denied.r.status,400);assert.equal(denied.calls.length,0);
 const allowed=await run('lumen_memory_remember',true);assert.equal(allowed.r.status,200);assert.equal(allowed.calls.length,1);
});
