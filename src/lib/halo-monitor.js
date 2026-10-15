// Les valeurs absentes restent null : elles ne deviennent jamais des zéros fictifs.
export function monitorSample(samples, backend, model) {
  return samples.filter(s => s.backend === backend && s.model === model)
    .sort((a,b) => b.ts - a.ts)[0] || null;
}
export async function loadHaloMonitor({ invoke, ollamaGetJson, backend, configuredContext, samples, chatContext }) {
  const name = backend.llama ? 'llama.cpp' : backend.applefm ? 'applefm' : backend.api ? 'api' : 'ollama';
  const result = { backend: name, model: backend.model || '', loaded: null, ctxTotal: configuredContext || null,
    ctxUsed: null, ctxSource: '', system: null, slots: [], errors: [], ts: Date.now() };
  const systemPromise = invoke('profiler_system_stats').then(s => { result.system = s; }).catch(e => result.errors.push(String(e)));
  try {
    if (backend.llama) {
      const status = await invoke('llama_status');
      result.loaded = !!status?.running;
      if (status?.running) {
        result.model = status.model || result.model;
        result.ctxTotal = status.ctx_size || result.ctxTotal;
        result.accelerator = status.backend;
        result.modelMemory = status.mem_bytes ?? null;
        result.memorySource = 'rss';
        const [props, slots] = await Promise.all([
          invoke('llama_get_json', {path:'props'}).catch(()=>null),
          invoke('llama_get_json', {path:'slots'}).catch(()=>null),
        ]);
        result.ctxTotal = props?.default_generation_settings?.n_ctx || result.ctxTotal;
        if (Array.isArray(slots)) result.slots = slots.map(s => ({ id:s.id, used:s.prompt_n ?? s.n_past ?? null, total:s.n_ctx || result.ctxTotal, busy:!!s.is_processing }));
        const active = result.slots.find(s=>s.busy) || result.slots[0];
        if (active && active.used != null) { result.ctxUsed = active.used; result.ctxTotal = active.total; result.ctxSource = 'slot'; }
      }
    } else if (!backend.api && !backend.applefm) {
      const ps = await ollamaGetJson('api/ps', backend.base);
      const model = ps?.models?.find(m => (m.name || m.model) === result.model || (m.name || m.model) === result.model + ':latest');
      result.loaded = !!model;
      if (model) {
        result.ctxTotal = model.context_length || result.ctxTotal;
        result.vram = model.size_vram ?? null;
        result.modelMemory = model.size != null && model.size_vram != null ? Math.max(0, model.size - model.size_vram) : null;
        result.memorySource = 'allocation';
        result.singleOllamaModel = ps.models.length === 1;
      }
    }
  } catch (error) { result.errors.push(String(error?.message || error)); }
  await systemPromise;
  if (result.singleOllamaModel) {
    const runners = (result.system?.processes || []).filter(p => p.kind === 'ollama' && /runner|llama_server/.test(p.name));
    if (runners.length) {
      result.modelMemory = runners.reduce((sum,p)=>sum+p.rss,0);
      result.memorySource = 'rss';
    }
  }
  const sample = monitorSample(samples, name, result.model);
  result.sample = sample;
  if (result.ctxUsed == null && chatContext?.backend === name && chatContext?.model === result.model) {
    result.ctxUsed = chatContext.used; result.ctxTotal = chatContext.total || result.ctxTotal;
    result.ctxSource = 'estimate'; result.contextTs = chatContext.ts;
  }
  if (result.ctxUsed == null && sample) {
    result.ctxUsed = sample.promptTokens; result.ctxTotal = result.ctxTotal || sample.ctxSize || null;
    result.ctxSource = 'sample'; result.contextTs = sample.ts;
  }
  return result;
}
