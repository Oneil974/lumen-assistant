import test from 'node:test';
import assert from 'node:assert/strict';
import { executionProfile, obviousDirect, chooseBackend, canOverrideModel, validateToolRequest, toolSucceeded } from '../src/lib/agent-policy.js';

const main = { api: false, base: 'http://localhost:11434', model: 'primary' };
const fast = { ...main, model: 'fast' }, strong = { ...main, model: 'strong' };
test('adaptive paths: simple reply, read, long task and effect', () => {
  assert.equal(executionProfile('Salut', { complexity: 'simple' }), 'direct');
  assert.equal(executionProfile('Météo demain', { needs_tools: true, complexity: 'simple' }), 'tools');
  assert.equal(executionProfile('Compare les devis', { needs_tools: true, complexity: 'complex' }), 'agent');
  assert.equal(executionProfile('Crée un rappel', { complexity: 'simple' }), 'agent');
  assert.ok(obviousDirect('Traduis : Bonjour'));
  assert.equal(obviousDirect('Quelle est la météo ?'), false);
  assert.equal(obviousDirect('Traduis : mon dernier mail', { strong: ['mail'] }), false);
});
test('decisions fall back to main; verification never uses the weak router', () => {
  assert.equal(chooseBackend({ main, fast, phase: 'route' }), fast);
  assert.equal(chooseBackend({ main, fast, phase: 'route', attempt: 1 }), main);
  assert.equal(chooseBackend({ main, fast, phase: 'verify' }), main);
  assert.equal(chooseBackend({ main, fast, strong, phase: 'infer', failures: 2 }), strong);
  assert.equal(chooseBackend({ main, phase: 'infer', failures: 2 }), main);
  assert.equal(canOverrideModel({ api: true, applefm: true }), false);
  assert.equal(canOverrideModel({ api: true, llama: true }), false);
});
test('unknown tools and invalid typed arguments cannot reach the executor', () => {
  const tools = [{ function: { name: 'write', parameters: { type: 'object', properties: { path: { type: 'string' }, count: { type: 'integer' } }, required: ['path'], additionalProperties: false } } }];
  assert.ok(validateToolRequest('shell', {}, tools));
  assert.ok(validateToolRequest('write', {}, tools));
  assert.ok(validateToolRequest('write', { path: 42 }, tools));
  assert.ok(validateToolRequest('write', { path: 'a', count: 2.5 }, tools));
  assert.ok(validateToolRequest('write', { path: 'a', unknown: true }, tools));
  assert.equal(validateToolRequest('write', { path: 'a', count: 2 }, tools), '');
});
test('failed or uncertain effects never become successful receipts', () => {
  for (const result of ['', 'Erreur : inaccessible', 'Échec', 'Résultat inconnu : envoi interrompu', { success: false }, { error: 'network' }]) assert.equal(toolSucceeded(result), false);
  assert.equal(toolSucceeded('Fichier écrit et relu : contenu vérifié'), true);
});
