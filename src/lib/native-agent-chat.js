import { toolMeta } from './tool-meta.js';
import { chooseBackend, validateToolRequest, toolSucceeded } from './agent-policy.js';

// Same run_agentic engine as scheduled/delegated agents. The existing host
// remains responsible for its tool permissions, rendering and model transport.
export async function runNativeAgentChat(o, analysis) {
  const core = globalThis.window?.__TAURI__?.core || globalThis.window?.parent?.__TAURI__?.core;
  if (!core?.Channel || !o.invoke || !o.sessionId) return null;
  const channel = new core.Channel();
  let token = '', failures = 0, reasoning = '';
  const notes = [], trace = [];
  const started = performance.now();
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    if (token) o.invoke('chat_runtime_cancel', { token }).catch(() => {});
  };
  o.signal?.addEventListener('abort', stop, { once: true });
  if (o.signal?.aborted) stop();
  globalThis.window?.addEventListener?.("beforeunload", stop);
  o.plan.start('agent', o.lang === 'en' ? 'Executing the task' : 'Exécution de la tâche', []);
  const mark = (kind, data) => trace.push({ ms: Math.round(performance.now() - started), step: 'agent', kind, ...data });
  channel.onmessage = event => {
    if (event.kind === 'started') { token = event.token; if (controller.signal.aborted) stop(); return; }
    void (async () => {
      let value;
      try {
        if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError');
        if (event.kind === 'tool') {
          const problem = validateToolRequest(event.name, event.args, o.tools || []);
          let result;
          if (problem) result = `Erreur de validation : ${problem}`;
          else result = await o.execTool(event.name, event.args, { signal: controller.signal, opId: `${token}:${event.operation}` });
          const success = toolSucceeded(result);
          const text = typeof result === 'string' ? result : JSON.stringify(result);
          if (!success) failures++;
          notes.push({ name: event.name, args: event.args, input: JSON.stringify(event.args), result: text });
          mark('tool', { name: event.name, ok: success });
          o.view.toolResult(notes.length - 1, event.name, event.args, text);
          o.plan.tool(event.name, event.name);
          o.view.nextTurn();
          value = { result: text, success };
        } else {
          const backend = chooseBackend({ main: o.backend, strong: o.strongBackend, phase: event.kind, attempt: event.attempt, failures: failures + (event.corrections || 0) * 2 });
          const messages = event.messages.map(m => ({ ...m }));
          if (event.images?.length) {
            const user = messages.find(m => m.role === 'user');
            if (user) user.images = event.images;
          }
          // Receipts remain authoritative in SQLite. Bound verification input
          // by the actual configured context, preserving both ends of each item.
          const res = await o.chat(messages, {
            ...(backend ? { backend } : {}), tools: event.tools?.length ? event.tools : undefined,
            rawSystem: true, source: 'agent-chat', signal: controller.signal,
            ...(event.kind === 'verify' ? { json: true } : {}),
            maxTokens: event.max_tokens || Math.min(2048, Math.floor((o.mainBackend?.contextTokens || 8192) / 4)),
            onUpdate: st => {
              if (st.reasoning) reasoning = st.reasoning;
              // The agent's final response is a JSON completion envelope.
              // Show progress/tool calls, then render the accepted report.
              if (event.kind === 'infer') o.view.update({ ...st, answer: '' });
            },
          });
          o.onUsage?.(res.data, `agent-${event.kind}`);
          mark('model', { phase: event.kind, model: backend?.model || o.mainBackend?.model || '', attempt: event.attempt || 0 });
          if (event.kind === 'infer') {
            const msg = res.data?.choices?.[0]?.message || res.data?.message || { role: 'assistant', content: res.content || '' };
            // Normalize Ollama batches into the same durable transcript as API calls.
            const calls = (msg.tool_calls || []).map((c, i) => ({ ...c, id: c.id || `call_${event.iteration}_${i}`, type: 'function' }));
            value = { choices: [{ message: { ...msg, ...(calls.length ? { tool_calls: calls } : {}) } }], usage: res.data?.usage || { prompt_tokens: res.data?.prompt_eval_count || 0, completion_tokens: res.data?.eval_count || 0 } };
          } else value = { content: res.content || '' };
        }
      } catch (error) {
        failures++;
        value = { error: String(error?.message || error) };
      }
      await o.invoke('chat_runtime_reply', { token, id: event.id, value }).catch(() => {});
    })();
  };
  try {
    const result = await o.invoke('chat_runtime_run', {
      request: {
        session: o.sessionId, turn: String(o.turnId ?? (o.history || []).length), query: o.query,
        history: [...(o.history || []), ...(o.pinned || []).map(p => ({ role: 'user', content: `Donnée choisie par l'utilisateur : ${p.result}` }))],
        images: o.images || [], tools: (o.tools || []).map(t => ({ ...t, lumen_read_only: toolMeta(t.function.name).readOnly })),
        criteria: analysis.subquestions || [], resume: /^(continue|continuer|reprends|reprendre|resume)[.!\s]*$/i.test(o.query.trim()),
        context_tokens: o.mainBackend?.contextTokens || 8192, max_iterations: o.limits?.agentIterations || 24,
      }, onEvent: channel,
    });
    if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError');
    const receipts = result.receipts || [];
    for (const receipt of receipts) if (receipt.result != null && !notes.some(n => n.name === receipt.tool && JSON.stringify(n.args) === JSON.stringify(receipt.args))) notes.push({ name: receipt.tool, args: receipt.args, input: JSON.stringify(receipt.args), result: receipt.result });
    const text = result.paused ? `${result.text}\n\n${o.lang === 'en' ? 'Say “continue” to resume this task.' : 'Dis « continuer » pour reprendre cette tâche.'}` : result.text;
    o.plan.done('agent', result.success ? 'ok' : 'warn', text.slice(0, 180));
    o.view.finish();
    o.plan.finish(result.success ? (o.lang === 'en' ? 'Task verified' : 'Tâche vérifiée') : (o.lang === 'en' ? 'Task incomplete' : 'Tâche incomplète'));
    mark('finish', { secs: (performance.now() - started) / 1000, success: result.success, runId: result.runId });
    return { text, display: text, sources: [], reasoning, toolNotes: notes, plan: o.plan.snapshot(), trace, success: result.success, runId: result.runId };
  } finally { o.signal?.removeEventListener('abort', stop); globalThis.window?.removeEventListener?.('beforeunload', stop); }
}
