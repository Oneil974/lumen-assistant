#!/usr/bin/env node
// Build the release frontend separately from editable sources and catalogue apps.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGES } from './app-packages.mjs';
import { collectDependencies } from './frontend-dependencies.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// These pages live in catalogue directories but implement core native features.
export const CORE_ENTRYPOINTS = ['browser/chrome.html', 'dbstudio/space.html'];
export const isReleaseFile = (path) => !path.split('/').some(part => part.startsWith('._') || part === '.DS_Store' || part.startsWith('__preview') || part === 'node_modules');
export function filesUnder(root, dir = '') {
  const result = [];
  for (const item of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${item.name}` : item.name;
    if (!isReleaseFile(rel)) continue;
    if (item.isSymbolicLink()) throw new Error(`Unexpected frontend symlink: ${rel}`);
    if (item.isDirectory()) result.push(...filesUnder(root, rel));
    else if (item.isFile()) result.push(rel);
  }
  return result.sort();
}
// exFAT can create AppleDouble sidecars during copy even when the source
// filter excluded them. Remove generated metadata from staging as well.
function removeMetadata(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.name.startsWith('._') || entry.name === '.DS_Store') rmSync(path, { force: true });
    else if (entry.isDirectory()) removeMetadata(path);
  }
}
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function packageHostPage(pkg) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(pkg.name)} — Lumen</title><script src="/lib/theme-init.js"></script><link rel="stylesheet" href="/lib/tokens.css"><link rel="stylesheet" href="/lib/ui.css"><link rel="stylesheet" href="/lib/appkit/package-window.css"></head><body class="ui" data-app-id="${esc(pkg.id)}"><main id="package-window" aria-live="polite"></main><script type="module" src="/lib/appkit/package-window.js"></script></body></html>\n`;
}
export function buildFrontend({ source = join(ROOT, 'src'), output = join(ROOT, 'dist/frontend'), packages = PACKAGES } = {}) {
  source = resolve(source); output = resolve(output);
  // Never delete sources or a parent of sources, even with a mistaken --out.
  if (output === source || !relative(output, source).startsWith('..') || output === ROOT || relative(ROOT, output).split(sep)[0] !== 'dist') {
    throw new Error('Frontend output must be inside dist/ and outside the source tree.');
  }
  const all = filesUnder(source);
  const appByDir = new Map(packages.map(pkg => [pkg.entry.split('/')[0], pkg]));
  const optional = rel => appByDir.has(rel.split('/')[0]);
  const coreEntries = CORE_ENTRYPOINTS.filter(rel => existsSync(join(source, rel)));
  const isCoreEntry = rel => coreEntries.includes(rel);
  const entries = [...all.filter(rel => !optional(rel)), ...coreEntries];
  // Imported stores/utilities from an optional app remain reachable, but its
  // pages are replaced with package hosts; do not pull its full asset library.
  const graph = collectDependencies(source, entries, { includeAppAssets: false, follow: rel => isReleaseFile(rel) && !(optional(rel) && !isCoreEntry(rel) && /\.html?$/i.test(rel)) });
  const selected = new Set([...entries, ...graph.files].filter(isReleaseFile));
  for (const dir of graph.assetDirs) for (const rel of filesUnder(source, dir)) selected.add(rel);
  const hosts = all.filter(rel => optional(rel) && !isCoreEntry(rel) && /\.html?$/i.test(rel));
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  for (const rel of [...selected].sort()) {
    const dest = join(output, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(source, rel), dest);
  }
  for (const rel of hosts) {
    const dest = join(output, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, packageHostPage(appByDir.get(rel.split('/')[0])));
  }
  removeMetadata(output);
  const sourceBytes = all.reduce((n, rel) => n + statSync(join(source, rel)).size, 0);
  const built = filesUnder(output);
  const frontendBytes = built.reduce((n, rel) => n + statSync(join(output, rel)).size, 0);
  const report = { sourceBytes, frontendBytes, savedBytes: sourceBytes - frontendBytes, files: built.length, packageHosts: hosts.length, packages: packages.map(p => p.id), retainedOptionalDependencies: [...selected].filter(optional).sort() };
  writeFileSync(join(dirname(output), `${basename(output)}-report.json`), JSON.stringify(report, null, 2) + '\n');
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--out');
  const report = buildFrontend({ output: index >= 0 ? resolve(ROOT, process.argv[index + 1]) : undefined });
  console.log(`Release frontend: ${(report.frontendBytes / 1048576).toFixed(2)} MiB (source ${(report.sourceBytes / 1048576).toFixed(2)} MiB; saved ${(report.savedBytes / 1048576).toFixed(2)} MiB), ${report.packageHosts} package hosts.`);
}
