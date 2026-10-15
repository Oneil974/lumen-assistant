#!/usr/bin/env node
// Dev reads editable sources; release builds embed only the staged core.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanBuildMetadata } from './clean-build-metadata.mjs';
cleanBuildMetadata(fileURLToPath(new URL('../src-tauri', import.meta.url)));
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
if (args[0] === 'dev') args.push('--config', JSON.stringify({ build: { frontendDist: '../src' } }));
const child = spawn(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...args], { stdio: 'inherit', env: process.env });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
