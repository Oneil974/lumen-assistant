import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSpeech } from '../src/lib/speech-check.js';
const create = (chat) => (text, options = {}) => checkSpeech(text, { chat, verify: true, ...options });
test('clear speech and stop keep original wording', async () => {
  const check = create(async () => ({ content: '{"status":"clear","text":"changed"}' }));
  assert.equal((await check('Ouvre mes agents')).text, 'Ouvre mes agents');
  assert.equal((await create(() => { throw Error('must not call'); })('stop')).text, 'stop');
});
test('repair is surfaced, ambiguity does not execute, unavailable model preserves transcript', async () => {
  const repair = create(async () => ({ content: '{"status":"repaired","text":"la banque"}' }));
  assert.deepEqual(await repair("l’abanc"), { text: 'la banque', original: 'l’abanc', checked: true });
  const unclear = create(async () => ({ content: '{"status":"unclear"}' }));
  assert.equal((await unclear('bruit')).unclear, true);
  const failed = create(async () => { throw Error('offline'); });
  assert.deepEqual(await failed('bonjour'), { text: 'bonjour', checked: true });
});

test('short clean transcripts bypass the model; explicit verification and suspicious text use it', async () => {
  let calls = 0;
  const chat = async () => { calls++; return { content: '{"status":"clear"}' }; };
  assert.deepEqual(await checkSpeech('Ouvre mes agents', { chat }), { text: 'Ouvre mes agents', checked: true });
  assert.equal(calls, 0);
  await checkSpeech('Ouvre mes agents', { chat, verify: true });
  await checkSpeech('agents agents agents agents', { chat });
  assert.equal(calls, 2);
});
