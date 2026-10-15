import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFrontend, isReleaseFile } from './build-frontend.mjs';
import { collectDependencies } from './frontend-dependencies.mjs';
const put = (root, rel, text) => { const path = join(root, rel); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

test('release removes app assets but preserves imported stores, workers, runtime assets and native entry URLs', () => {
  const source = mkdtempSync(join(tmpdir(), 'lumen-frontend-source-'));
  const output = resolve('dist/frontend-test-fixture');
  try {
    put(source, 'index.html', '<script type="module" src="/main.js"></script>');
    put(source, 'main.js', 'import { state } from "./notes/store.js"; new Worker(new URL("./worker.js", import.meta.url));');
    put(source, 'worker.js', 'export const ready = true;');
    put(source, 'notes/store.js', 'export { state } from "./state.js";');
    put(source, 'notes/state.js', 'export const state = {};');
    put(source, 'notes/notes.html', '<script src="./editor.js"></script>');
    put(source, 'notes/editor.js', 'throw new Error("must stay outside core")');
    put(source, 'notes/assets/heavy.bin', 'x'.repeat(5000));
    put(source, '__preview-demo.html', 'preview only');
    put(source, '._main.js', 'invalid metadata');
    put(source, 'lib/__preview-test.js', 'preview only');
    const report = buildFrontend({ source, output, packages: [{ id: 'notes', name: 'Notes', entry: 'notes/notes.html' }] });
    for (const rel of ['index.html', 'main.js', 'worker.js', 'notes/store.js', 'notes/state.js']) assert.ok(existsSync(join(output, rel)), rel);
    for (const rel of ['notes/editor.js', 'notes/assets/heavy.bin', '__preview-demo.html', '._main.js', 'lib/__preview-test.js']) assert.equal(existsSync(join(output, rel)), false, rel);
    assert.match(readFileSync(join(output, 'notes/notes.html'), 'utf8'), /data-app-id="notes"/);
    assert.equal(report.packageHosts, 1);
    assert.ok(report.savedBytes > 4000);
    const again = buildFrontend({ source, output, packages: [{ id: 'notes', name: 'Notes', entry: 'notes/notes.html' }] });
    assert.deepEqual(again, report);
    assert.throws(() => buildFrontend({ source, output: source }), /outside the source tree/);
    assert.ok(existsSync(join(source, 'main.js')));
  } finally { rmSync(source, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); }
});
test('catalogue graph keeps application assets; core graph does not implicitly copy them', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumen-graph-'));
  try {
    put(root, 'notes/notes.html', '<script src="./main.js"></script>');
    put(root, 'notes/main.js', 'import "./style.css";');
    put(root, 'notes/style.css', 'body { background: url("./assets/a.png"); }');
    put(root, 'notes/assets/a.png', 'image');
    put(root, 'notes/assets/b.png', 'dynamic image');
    const catalog = collectDependencies(root, ['notes/notes.html']);
    assert.ok(catalog.assetDirs.has('notes/assets'));
    const core = collectDependencies(root, ['notes/main.js'], { includeAppAssets: false });
    assert.equal(core.assetDirs.has('notes/assets'), false);
    assert.ok(core.files.has('notes/assets/a.png'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('release file filter excludes AppleDouble and developer previews at every depth', () => {
  for (const path of ['._x', 'lib/._x', 'lib/__preview-ui.html', '.DS_Store']) assert.equal(isReleaseFile(path), false);
  assert.equal(isReleaseFile('lib/avatars/metrocity/body.png'), true);
});
