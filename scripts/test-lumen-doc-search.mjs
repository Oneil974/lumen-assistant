import test from 'node:test';
import assert from 'node:assert/strict';
import { searchLumenDocs } from '../src/lib/lumen-doc-search.js';

test('documentation search retries failed loads, ranks accents/categories and shares its cached index', async () => {
  const previousFetch = globalThis.fetch;
  const previousParser = globalThis.DOMParser;
  let calls = 0;
  const sections = [
    { page: 'memoire', title: 'Mémoire', text: 'Retrouver les événements mémorisés' },
    { page: 'fluxo', title: 'Fluxo', text: 'Créer des automatisations et événements' },
  ].map((item) => ({ dataset: { page: item.page }, textContent: item.text, querySelector: () => ({ textContent: item.title }) }));
  globalThis.fetch = async () => (++calls === 1 ? { ok: false, status: 503 } : { ok: true, text: async () => '' });
  globalThis.DOMParser = class { parseFromString() { return { querySelectorAll: (selector) => selector.startsWith('section') ? sections : [] }; } };
  try {
    await assert.rejects(searchLumenDocs('memoire'), /503/);
    assert.match(await searchLumenDocs('memoire'), /^\[1\] Mémoire/);
    assert.match(await searchLumenDocs('événements', 'fluxo'), /^\[1\] Fluxo/);
    assert.equal(calls, 2);
    assert.match(await searchLumenDocs('zzzz'), /Aucune page/);
  } finally { globalThis.fetch = previousFetch; globalThis.DOMParser = previousParser; }
});
