import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const src=readFileSync(new URL('../src/companion.js',import.meta.url),'utf8');
test('switching Messages closes blockers and classic returns without remounting the messenger',()=>{
 const root={hidden:true};const body={dataset:{}};let closeCount=0,mountCount=0,refreshCount=0;
 const context={document:{body,documentElement:{lang:'fr'}},localStorage:{setItem(){}},$:(id)=>root,closeSheets:()=>closeCount++,closeDrawer:()=>closeCount++,mxTransport:{},mx:null,mountMessenger:()=>{mountCount++;return {refresh:()=>refreshCount++,open:()=>{}}}};
 vm.createContext(context);
 vm.runInContext(src.slice(src.indexOf('function openMessages(threadId)'),src.indexOf('$("btn-messages")?.addEventListener')),context);
 context.openMessages();assert.equal(root.hidden,false);assert.equal(body.dataset.companionMode,'messages');assert.equal(closeCount,2);
 context.closeMessages();assert.equal(root.hidden,true);assert.equal(body.dataset.companionMode,undefined);
 context.openMessages();assert.equal(mountCount,1);assert.equal(refreshCount,1);
});
