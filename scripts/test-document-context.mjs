import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDocumentContext } from '../src/lib/document-context.js';
const project = { id: 'p', name: 'Project', files: [{ docId: 'project-doc', kind: 'doc', chars: 30000 }], instructions: '' };
const labels = { extracts: 'Extraits', cite: 'Citer les sources', truncated: '[tronqué]' };
test('attached documents and long project documents are searched together, isolated from other projects', async () => {
  let args;
  const result = await collectDocumentContext({ query: 'budget', project, documents: [{ mode: 'rag', docId: 'attachment' }, { mode: 'rag', docId: 'project-doc' }], labels, search: async value => { args = value; return [{ title: 'Budget', text: '42', doc_id: 'project-doc' }]; } });
  assert.deepEqual(args.docIds, ['attachment', 'project-doc']);
  assert.equal(result.status, 'found');
  assert.match(result.parts[0], /\[1\] \(Budget\) 42/);
  assert.equal(result.hits[0].doc_id, 'project-doc');
});
test('small project corpus stays in the system context; only explicit RAG mode searches the whole base', async () => {
  const small = { ...project, files: [{ docId: 'short', kind: 'doc', text: 'body', chars: 4 }] };
  const never = () => { throw new Error('must not search'); };
  assert.deepEqual((await collectDocumentContext({ query: 'q', project: small, search: never })).hits, []);
  let args;
  await collectDocumentContext({ query: 'q', project, ragMode: true, search: async value => { args = value; return []; } });
  assert.equal(args.docIds, null);
});
test('full attachment is injected once and failed search has bounded fallback with an explicit status', async () => {
  const documents = [{ mode: 'full', name: 'Short', text: 'short' }, { mode: 'rag', docId: 'long', name: 'Long', text: 'long document' }];
  const run = () => collectDocumentContext({ query: 'q', documents, fullChars: 4, labels, search: async () => { throw Error('offline'); } });
  const first = await run();
  assert.equal(first.status, 'fallback'); assert.equal(first.failure, 'offline');
  assert.deepEqual(first.parts, ['--- Short ---\nshort', '--- Long ---\nlong\n[tronqué]']);
  const second = await run();
  assert.deepEqual(second.parts, []); assert.equal(second.status, 'failed');
});
