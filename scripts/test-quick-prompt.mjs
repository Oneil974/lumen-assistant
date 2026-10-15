import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/quick-prompt.js',import.meta.url),'utf8').replace(/^import .*;\n/, '');
function harness() {
  const elements = new Map(), events = {}, requests = [], calls = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { value:'', textContent:'', hidden:false, disabled:false, scrollHeight:160, handlers:{}, addEventListener(name,fn) { this.handlers[name]=fn; }, focus(){}, select(){}, setAttribute(){}, requestSubmit() { return this.handlers.submit({preventDefault(){}}); } }); return elements.get(id); };
  const context = { localStorage:{getItem:()=>null},navigator:{language:'fr-FR'},AbortController,console,
    document:{documentElement:{},getElementById:element,querySelector:element,addEventListener(name,fn){events[name]=fn;}},
    window:{__TAURI__:{core:{invoke:async(name,args)=>{calls.push({name,args});}},event:{listen(name,fn){events[name]=fn;}}}},
    llmBackend:()=>({source:'llama',model:'test'}),llmChat:(messages,opts)=>new Promise((resolve,reject)=>requests.push({messages,opts,resolve,reject})),
  };
  vm.runInNewContext(source,context);
  return {element,events,requests,calls,submit(value) { element('prompt').value=value; return element('prompt-form').requestSubmit(); }};
}
test('quick response uses the active model, bounded generation and plain text without tools',async()=>{
  const h=harness(), pending=h.submit('Question');
  assert.equal(h.requests.length,1); const request=h.requests[0];
  assert.equal(request.opts.maxTokens,512); assert.equal(request.opts.think,false); assert.equal(request.opts.tools,undefined);
  assert.equal(request.messages.at(-1).content,'Question');
  request.opts.onDelta('<script>texte</script>');
  assert.equal(h.element('answer').textContent,'<script>texte</script>');
  request.resolve({content:'Réponse'}); await pending;
  assert.equal(h.element('answer').textContent,'Réponse'); assert.equal(h.element('copy').hidden,false);
  assert.equal(h.element('send').disabled,false);
});
test('Escape aborts generation, hides the window and rejects a stale response on reopening',async()=>{
  const h=harness(), pending=h.submit('Ancienne question'); const first=h.requests[0];
  h.events.keydown({key:'Escape',preventDefault(){}});
  assert.equal(first.opts.signal.aborted,true); assert.ok(h.calls.some(c=>c.name==='quick_prompt_hide'));
  h.events['quick-prompt-focus'](); const next=h.submit('Nouvelle question');
  first.opts.onDelta('Ancienne réponse'); first.resolve({content:'Ancienne réponse'}); await pending;
  assert.equal(h.element('answer').textContent,'');
  h.requests[1].resolve({content:'Nouvelle réponse'}); await next;
  assert.equal(h.element('answer').textContent,'Nouvelle réponse');
});
test('empty prompts and repeated submit cannot start competing requests',async()=>{
  const h=harness(); await h.submit('   '); assert.equal(h.requests.length,0);
  const pending=h.submit('Question'); await h.submit('Autre'); assert.equal(h.requests.length,1);
  h.requests[0].resolve({content:'ok'}); await pending;
});
