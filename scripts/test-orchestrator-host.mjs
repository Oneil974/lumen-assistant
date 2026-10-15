import test from 'node:test';
import assert from 'node:assert/strict';
import { orchestrationBackends } from '../src/lib/orchestrator-host.js';
const store = values => ({ getItem: key => values[key] ?? null });
test('one backend snapshot supplies main context and same-provider overrides to every surface', () => {
  const backend = { model: 'primary', base: 'http://localhost:11434' };
  const settings = store({ orchestratorFastModel: ' fast ', orchestratorStrongModel: 'strong', orchestratorStrongProvider: 'ollama:http://localhost:11434', ollamaNumCtx: '16384' });
  const turn = orchestrationBackends(backend, settings);
  backend.model = 'changed';
  assert.equal(turn.backend.model, 'primary');
  assert.equal(turn.mainBackend.contextTokens, 16384);
  assert.equal(turn.fastBackend.model, 'fast');
  assert.equal(turn.strongBackend.model, 'strong');
  assert.equal(turn.strongBackend.base, turn.backend.base);
});
test('Apple and embedded engines cannot silently switch model; provider mismatches cannot escalate', () => {
  const settings = store({ orchestratorFastModel: 'fast', orchestratorStrongModel: 'strong', orchestratorStrongProvider: 'api:http://other' });
  for (const flag of ['applefm', 'llama', 'litert', 'lumen']) {
    const turn = orchestrationBackends({ [flag]: true, model: 'primary' }, settings);
    assert.equal(turn.fastBackend, null); assert.equal(turn.strongBackend, null);
    if (flag === 'applefm') assert.equal(turn.mainBackend.contextTokens, 4096);
  }
  assert.equal(orchestrationBackends({ api: true, base: 'http://selected', model: 'primary' }, settings).strongBackend, null);
});
