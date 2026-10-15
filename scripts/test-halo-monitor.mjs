import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHaloMonitor, monitorSample } from '../src/lib/halo-monitor.js';
const base = { configuredContext:8192, samples:[], chatContext:null };
test('llama exposes server RSS and live slot context', async()=>{
  const m=await loadHaloMonitor({...base,backend:{llama:true,model:'model'},invoke:async(cmd,args)=>{
    if(cmd==='profiler_system_stats')return {total_memory:16000,used_memory:10000};
    if(cmd==='llama_status')return {running:true,model:'model',mem_bytes:4000,ctx_size:8192,backend:'metal'};
    return args.path==='props'?{default_generation_settings:{n_ctx:4096}}:[{id:0,prompt_n:500,n_ctx:4096,is_processing:true}];
  }});
  assert.equal(m.modelMemory,4000); assert.equal(m.memorySource,'rss');
  assert.equal(m.ctxUsed,500); assert.equal(m.ctxTotal,4096); assert.equal(m.ctxSource,'slot');
});
test('ollama separates GPU allocation and prefers runner RSS for a single loaded model',async()=>{
  const m=await loadHaloMonitor({...base,backend:{model:'model'},invoke:async()=>({processes:[{kind:'ollama',name:'ollama-runner',rss:900}]}),ollamaGetJson:async()=>({models:[{name:'model:latest',size:1000,size_vram:400,context_length:4096}]})});
  assert.equal(m.modelMemory,900); assert.equal(m.vram,400); assert.equal(m.memorySource,'rss');
});
test('multiple loaded models cannot claim combined runner RSS as memory of one model',async()=>{
  const m=await loadHaloMonitor({...base,backend:{model:'a'},invoke:async()=>({processes:[{kind:'ollama',name:'ollama-runner',rss:9999}]}),ollamaGetJson:async()=>({models:[{name:'a',size:1000,size_vram:400},{name:'b'}]})});
  assert.equal(m.modelMemory,600);assert.equal(m.memorySource,'allocation');
});
test('context does not reuse measurements from another model and missing RAM stays unavailable',async()=>{
  const m=await loadHaloMonitor({...base,backend:{api:true,model:'a'},invoke:async()=>{throw Error('unavailable')},samples:[{backend:'api',model:'b',ts:100,promptTokens:500}]});
  assert.equal(m.ctxUsed,null); assert.equal(m.modelMemory,undefined); assert.equal(m.system,null);
  assert.equal(monitorSample([{backend:'api',model:'a',ts:1},{backend:'api',model:'a',ts:2}],'api','a').ts,2);
});
