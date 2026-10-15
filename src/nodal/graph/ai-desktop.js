import { explicitInferenceSource, assertAppleModel } from "../../lib/inference-source.js";
import { llmChat, llmBackend, backendForSource, appleFmBackendState } from '../../llm.js';
export function desktopAI(invoke) {
  return {
    lumen: (action,args) => invoke('nodal_tool_exec', {name:action,args}),
    fluxo: (name, input) => { if (!invoke) throw new Error('Fluxo nécessite Lumen.'); return invoke('run_fluxo_workflow', { name, input: String(input ?? ''), runId: null, extraVars: null }); },
    chat: async (messages, config = {}, tools = []) => {
      const active = llmBackend();
      const source = explicitInferenceSource(config.backend);
      let model = config.model;
      if (source === 'applefm') model = assertAppleModel(await appleFmBackendState(), model);
      const backend = source ? backendForSource(source) : config.backend === 'local' && active.api && !active.llama && !active.litert && !active.applefm ? backendForSource('ollama') : active;
      const opts = { backend, model: model || backend.model, maxTokens: Math.min(8192, Math.max(1, Number(config.maxTokens) || 1024)), tools, stream: false };
      const r = await llmChat(messages, opts);
      return r.data?.choices?.[0]?.message || r.data?.message || { content: r.content };
    },
  };
}
