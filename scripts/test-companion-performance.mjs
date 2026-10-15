import test from 'node:test';
import assert from 'node:assert/strict';
import { latestRender, transcriptWindow } from '../src/lib/companion-performance.js';
function harness() {
 let hidden=false,id=0;const jobs=new Map(),renders=[];
 const renderer=latestRender(v=>renders.push(v),{hidden:()=>hidden,schedule:fn=>{jobs.set(++id,fn);return id;},cancel:id=>jobs.delete(id)});
 return {renderer,jobs,renders,hide(v){hidden=v;},tick(){const batch=[...jobs.values()];jobs.clear();batch.forEach(fn=>fn());}};
}
test('a streaming burst paints only the latest snapshot',()=>{
 const h=harness();for(let i=0;i<1000;i++)h.renderer.push(i);
 assert.equal(h.jobs.size,1);h.tick();assert.deepEqual(h.renders,[999]);
 h.renderer.push(1000);h.tick();assert.deepEqual(h.renders,[999,1000]);
});
test('a sleeping phone retains one snapshot without rendering or queued timers',()=>{
 const h=harness();h.renderer.push('before');h.hide(true);h.renderer.pause();
 for(let i=0;i<100;i++)h.renderer.push(i);
 assert.equal(h.jobs.size,0);assert.equal(h.renders.length,0);
 h.hide(false);h.renderer.resume();h.renderer.resume();assert.equal(h.jobs.size,1);h.tick();assert.deepEqual(h.renders,[99]);
});
test('a hidden page during a scheduled paint resumes without losing state',()=>{
 const h=harness();h.renderer.push('latest');h.hide(true);h.tick();assert.equal(h.renders.length,0);
 h.hide(false);h.renderer.resume();h.tick();assert.deepEqual(h.renders,['latest']);
 h.renderer.push('obsolete');h.renderer.clear();h.tick();assert.deepEqual(h.renders,['latest']);
});
test('long conversations keep stable indices and a bounded initial DOM window',()=>{
 const messages=Array.from({length:10000},(_,i)=>({sender:'assistant',text:String(i)}));
 const window=transcriptWindow(messages);assert.equal(window.length,120);assert.equal(window[0].index,9880);assert.equal(window.at(-1).index,9999);
 assert.equal(transcriptWindow(messages)[0].signature,window[0].signature);
 const enlarged=transcriptWindow(messages,240);assert.equal(enlarged[120].index,window[0].index);
});
