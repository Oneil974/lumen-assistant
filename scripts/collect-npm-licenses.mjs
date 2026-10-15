// Preserve notices separately from minified libraries, including dependencies.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
const out = join(root, 'src/legal/npm');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const inventory = [];
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path) continue;
  const dir = join(root, path);
  if (!existsSync(dir)) {
    if (info.optional) continue; // platform-specific tooling is absent by design
    throw new Error(`Missing ${path}: run npm ci before collecting licenses`);
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json')));
  const texts = readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && /^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(e.name));
  const label = path.replaceAll('node_modules/', '').replaceAll('/', '__');
  const files = texts.map(e => {
    const name = `${label}--${e.name}.txt`;
    writeFileSync(join(out, name), readFileSync(join(dir, e.name)));
    return name;
  });
  inventory.push({ name: pkg.name, version: info.version, license: pkg.license || info.license || 'UNDECLARED', files });
}
writeFileSync(join(out, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
const missing = inventory.filter(p => !p.files.length);
console.log(`${inventory.length} npm packages inventoried; ${missing.length} without a standalone root license/notice file.`);
for (const p of missing) console.log(`Review: ${p.name}@${p.version} (${p.license})`);
