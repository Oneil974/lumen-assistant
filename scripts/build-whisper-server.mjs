// Construit whisper-server (whisper.cpp) pour la plateforme courante.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
// Un échec de whisper ne doit pas bloquer la build de Lumen : la dictée retombe
// sur transformers.js. WHISPER_REQUIRED=1 rend l'échec bloquant (release).
const result = isWindows
  ? spawnSync("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "build-whisper-server.ps1")], { cwd: root, stdio: "inherit", env: process.env })
  : spawnSync("bash", [path.join(root, "scripts", "build-whisper-server.sh")], { cwd: root, stdio: "inherit", env: process.env });
if (result.status !== 0 && process.env.WHISPER_REQUIRED !== "1") {
  console.warn("⚠ whisper-server non construit : la dictée utilisera la transcription JS.");
  process.exit(0);
}
process.exit(result.status ?? 1);
