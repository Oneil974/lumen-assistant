// macOS/exFAT creates AppleDouble files that Tauri may mistake for JSON/TOML
// permissions. Remove only filesystem metadata from configuration directories.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
export function cleanBuildMetadata(root) {
  let count = 0;
  const walk = dir => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isFile() && (entry.name.startsWith('._') || entry.name === '.DS_Store')) { rmSync(path); count++; }
      else if (entry.isDirectory()) walk(path);
    }
  };
  for (const dir of ['capabilities', 'permissions']) walk(join(root, dir));
  return count;
}
