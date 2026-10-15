import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfDocument, recognizeImage } from '../src/studies/ocr.js';
import { LLAMA_MODEL_CATALOG } from '../src/llama-models.js';
import { modelGroup } from '../src/lib/model-groups.js';
function pdf(texts) {
  const cleaned = [];
  return { cleaned, numPages: texts.length, async getPage(n) { return { async getTextContent() { return { items: [{ str: texts[n-1] }] }; }, cleanup() { cleaned.push(n); } }; } };
}
test('mixed PDF preserves native text and OCRs only scanned pages in order', async () => {
  const native = 'Un document avec suffisamment de texte natif pour être conservé.';
  const doc = pdf([native, '', native]); const seen = [];
  const result = await extractPdfDocument(doc, { ocrPage: async (_, n) => { seen.push(n); return 'Texte numérisé'; } });
  assert.deepEqual(seen, [2]); assert.deepEqual(doc.cleaned, [1,2,3]);
  assert.match(result, /\[Page 1\][\s\S]*document[\s\S]*\[Page 2\]\nTexte numérisé[\s\S]*\[Page 3\]/);
});
test('OCR failure never silently imports an incomplete document', async () => {
  const doc = pdf(['', '']);
  await assert.rejects(extractPdfDocument(doc, { ocrPage: async () => { throw new Error('OCR indisponible'); } }), /indisponible/);
  assert.deepEqual(doc.cleaned, [1]);
});
test('cancelling an in-flight page prevents subsequent OCR and discards its result', async () => {
  const controller = new AbortController(), doc = pdf(['','']); let pages = 0;
  await assert.rejects(extractPdfDocument(doc, { signal: controller.signal, ocrPage: async () => { pages++; controller.abort(); return 'partial'; } }), { name: 'AbortError' });
  assert.equal(pages,1); assert.deepEqual(doc.cleaned,[1]);
});
test('missing projector prevents inference; OCR never calls a cloud backend', async () => {
  const calls = [];
  await assert.rejects(recognizeImage(async command => { calls.push(command); return [{ id:'glm-ocr', installed:false }]; }, 'data:image/png;base64,AA', { model:'glm-ocr' }), /Installez/);
  assert.deepEqual(calls,['ocr_models']);
});
test('bounded imports and downloadable GGUF OCR pairs', async () => {
  await assert.rejects(extractPdfDocument({numPages:201}), /200 pages/);
  const models = LLAMA_MODEL_CATALOG.filter(m => m.tags.includes('ocr'));
  assert.equal(models.length,2);
  for (const model of models) {
    assert.equal(modelGroup(model),'ocr');
    for (const url of [model.url,model.mmprojUrl]) { assert.equal(new URL(url).hostname,'huggingface.co'); assert.ok(url.endsWith('.gguf')); }
    assert.ok(model.sizeBytes > 1e9 && model.sizeBytes < 2e9);
  }
});
