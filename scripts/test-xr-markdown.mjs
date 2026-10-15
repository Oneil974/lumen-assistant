import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (await readFile(new URL('../src/xr-panels.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
const { markdownLines, drawMarkdownLine } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const ctx = { measureText: (s) => ({ width: s.length * 10 }), fillText() {} };
const text = (rows) => rows.map(r => r.runs.map(x => x.text).join('')).join('\n');
test('XR markdown preserves words and styles headings, bold, code, quotes and lists', () => {
  const rows = markdownLines(ctx, '# Titre\nUn **mot fort** et `code`\n> citation\n- item', 1000);
  assert.equal(text(rows), 'Titre\nUn mot fort et code\ncitation\n• item');
  assert.match(rows[0].runs[0].font, /700/);
  assert.ok(rows[1].runs.some(r => r.code));
  assert.ok(rows[2].runs.every(r => r.quote));
  rows.forEach(row => drawMarkdownLine(ctx, row, 0, 0));
});
test('XR long words fit the panel and fenced code keeps punctuation', () => {
  const rows = markdownLines(ctx, 'abcdefghijklmnop\n```js\n**literal**\n```', 60);
  assert.ok(rows.every(row => row.width <= 60));
  assert.equal(text(rows).replaceAll('\n', ''), 'abcdefghijklmnop**literal**');
});
