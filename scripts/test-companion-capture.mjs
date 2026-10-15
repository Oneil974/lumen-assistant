import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

// Exercise the real capture handlers without a server or browser credentials.
const source = readFileSync(new URL('../src/companion.js', import.meta.url), 'utf8');
const capture = source.slice(source.indexOf('const captureSheet ='), source.indexOf('// ---- Activité des agents'));
function harness() {
  const storage = new Map(), elements = new Map(), calls = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', innerHTML: '', hidden: true, disabled: false,
      dataset: {}, attrs: {}, handlers: {},
      classList: { toggle() { return true; } },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      querySelectorAll() { return []; },
      setAttribute(k, v) { this.attrs[k] = v; }, focus() {}, click() {},
    });
    return elements.get(id);
  }
  element('capture-when').value = '3600000';
  let apiHandler = async path => path === '/agents/list' ? { items: [{ id: 'designer', name: 'Designer', avatar: { color: 'purple' } }] } : { ok: true };
  const context = vm.createContext({
    $: element, identity: { id: 'profile-a' }, location: { host: 'localhost' },
    crypto: { randomUUID }, agentDir: [], agentDirAt: 0,
    newId: randomUUID,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    api: async (path, options) => { calls.push({ path, body: options?.body && JSON.parse(options.body) }); return apiHandler(path, options); },
    tt: s => s, esc: s => String(s).replaceAll('<', '&lt;'),
    agentAvatarHTML: a => `<avatar>${a.id}</avatar>`,
    closeDrawer() {}, openSheet() {}, closeSheets() {}, toast() {}, setTimeout() {},
  });
  vm.runInContext(capture, context);
  return { element, storage, calls, context,
    setAPI: f => { apiHandler = f; },
    open: () => vm.runInContext('openCapture()', context),
    fire: (id, type = 'click', event = {}) => element(id).handlers[type]({ currentTarget: element(id), ...event }),
  };
}

test('note draft survives reopening, includes title and stable retry identity', async () => {
  const h = harness(); h.open();
  h.element('capture-title').value = 'Idée';
  h.element('capture-text').value = 'Texte à garder';
  h.fire('capture-text', 'input');
  const key = 'captureDraft:localhost:profile-a';
  const id = JSON.parse(h.storage.get(key)).id;
  h.open();
  assert.equal(h.element('capture-text').value, 'Texte à garder');
  h.setAPI(async () => { throw Error('offline'); });
  await h.fire('capture-send');
  assert.equal(JSON.parse(h.storage.get(key)).id, id);
  h.setAPI(async () => ({ ok: true }));
  await h.fire('capture-send');
  const sent = h.calls.filter(c => c.path === '/capture');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.id, sent[1].body.id);
  assert.equal(sent[1].body.kind, 'note');
  assert.equal(sent[1].body.text, 'Idée\n\nTexte à garder');
  assert.equal(h.storage.has(key), false);
});

test('failed AI correction preserves original; stale results cannot overwrite edits', async () => {
  const h = harness(); h.open();
  h.element('capture-text').value = 'Original'; h.fire('capture-text', 'input');
  h.setAPI(async () => { throw Error('modèle indisponible'); });
  await h.fire('capture-refine');
  assert.equal(h.element('capture-text').value, 'Original');
  assert.equal(h.element('capture-refine').disabled, false);
  let resolve;
  h.setAPI(() => new Promise(r => { resolve = r; }));
  const pending = h.fire('capture-refine');
  h.element('capture-text').value = 'Nouvelle idée'; h.fire('capture-text', 'input');
  resolve({ text: 'Ancien texte corrigé' }); await pending;
  assert.equal(h.element('capture-text').value, 'Nouvelle idée');
  assert.equal(h.element('capture-review').hidden, true);
});

test('AI edits are proposed before acceptance and saved only after user applies them', async () => {
  const h = harness(); h.open();
  h.element('capture-text').value = 'bonjor'; h.fire('capture-text', 'input');
  h.setAPI(async () => ({ text: 'Bonjour' }));
  await h.fire('capture-refine');
  assert.equal(h.element('capture-text').value, 'bonjor');
  assert.equal(h.element('capture-review').hidden, false);
  h.fire('capture-reject'); assert.equal(h.element('capture-text').value, 'bonjor');
  await h.fire('capture-refine'); h.fire('capture-accept');
  assert.equal(h.element('capture-text').value, 'Bonjour');
  assert.equal(h.element('capture-review').hidden, true);
});

test('empty notes are blocked and newer drafts survive an in-flight save', async () => {
  const h = harness(); h.open();
  await h.fire('capture-send');
  assert.equal(h.calls.some(c => c.path === '/capture'), false);
  h.element('capture-text').value = 'Première idée'; h.fire('capture-text', 'input');
  let resolve;
  h.setAPI(() => new Promise(r => { resolve = r; }));
  const pending = h.fire('capture-send');
  h.element('capture-text').value = 'Deuxième idée'; h.fire('capture-text', 'input');
  resolve({ ok: true }); await pending;
  assert.equal(JSON.parse(h.storage.get('captureDraft:localhost:profile-a')).text, 'Deuxième idée');
});

test('agent choice shows its visual identity and list formatting is repeatable', async () => {
  const h = harness();
  await vm.runInContext('loadCaptureAgents()', h.context);
  h.element('capture-agent').value = 'designer'; h.fire('capture-agent', 'change');
  assert.match(h.element('capture-agent-preview').innerHTML, /<avatar>designer<\/avatar>/);
  h.element('capture-text').value = 'Une idée\n\n- Déjà une liste';
  h.fire('capture-list'); h.fire('capture-list');
  assert.equal(h.element('capture-text').value, '- Une idée\n\n- Déjà une liste');
});
