import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../src/orb-bridge.js',import.meta.url),'utf8');
const pushCode=source.slice(source.indexOf('  let pushingAgents = false;'),source.indexOf('  OrbBridge.pushAgents = pushAgents;'))
  .replace("await import('/lib/agent-avatar.js')",'avatarModule');
function harness(failAt=0){
  const calls=[],tasks=[];let sprites=0;
  const context={isFire:()=>true,connectedTo:{orb:true},slotFor:()=> 'orb',agentCache:[],SPRITE:112,
    avatarModule:{avatarColor:()=> '#7873ee'},renderAgentFrame:async()=> 'sprite',
    console:{warn:()=>{}},setTimeout:fn=>{tasks.push(fn);},
    invoke:async(cmd,args)=>{calls.push([cmd,args]);if(cmd==='agent_list')return [{id:'a1',name:'Agent'}];
      if(cmd==='agents_running')return [];if(cmd==='orb_send_sprite'&&++sprites===failAt)throw Error('transport');},
  };
  vm.createContext(context);vm.runInContext(pushCode+'\nglobalThis.push=pushAgents;',context);
  return {context,calls,tasks};
}
test('manual refresh immediately retries a failed sprite transfer',async()=>{
  const {context,calls}=harness(1);await context.push(true);await context.push(true);
  assert.equal(calls.filter(([cmd])=>cmd==='orb_send_sprite').length,4);
});
test('manual refresh resends images even immediately after a successful transfer',async()=>{
  const {context,calls}=harness();await context.push(true);await context.push(true);
  assert.equal(calls.filter(([cmd])=>cmd==='orb_send_sprite').length,6);
});
test('refresh during a transfer is queued instead of lost',async()=>{
  const {context,calls,tasks}=harness();const first=context.push(true);await context.push(true);await first;
  assert.equal(tasks.length,1);await tasks[0]();
  assert.equal(calls.filter(([cmd])=>cmd==='orb_send_sprite').length,6);
});
test('failed avatar image loads are evicted and can be retried',async()=>{
  const code=source.slice(source.indexOf('  const imgCache = new Map();'),source.indexOf('  async function renderAgentFrame'));
  let attempt=0;
  class Image {set src(value){queueMicrotask(()=>++attempt===1?this.onerror():this.onload());}}
  const context={Image};vm.createContext(context);vm.runInContext(code+'\nglobalThis.load=loadImg;',context);
  await assert.rejects(context.load('/avatar.png'),/image introuvable/);
  assert.ok(await context.load('/avatar.png'));assert.equal(attempt,2);
});
