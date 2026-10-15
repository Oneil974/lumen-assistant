// Empaquette le moteur Bonsai Image pour l'OS courant : .sh sur macOS/Linux,
// .ps1 sur Windows (même aiguillage que build-llama-server.mjs).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const script = path.join(root, "scripts", isWindows ? "build-bonsai-engine.ps1" : "build-bonsai-engine.sh");
const command = isWindows ? "powershell.exe" : "bash";
const args = isWindows ? ["-ExecutionPolicy", "Bypass", "-File", script] : [script];
const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
