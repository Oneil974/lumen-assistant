#!/usr/bin/env node
// Génère la paire de clés de signature de l'updater et inscrit la clé PUBLIQUE
// dans src-tauri/tauri.conf.json.
//
//   node scripts/setup-updater.mjs
//
// À ne lancer QU'UNE FOIS pour toute la vie du produit : si la clé privée est
// perdue ou changée, les installations déjà déployées ne pourront plus vérifier
// les mises à jour et devront être réinstallées à la main.
//
// La clé privée est écrite dans ~/.lumen/updater.key (hors du dépôt). Copie-la
// dans le secret GitHub TAURI_SIGNING_PRIVATE_KEY pour que la CI puisse signer.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const confPath = join(root, "src-tauri", "tauri.conf.json");
const keyDir = join(homedir(), ".lumen");
const keyPath = join(keyDir, "updater.key");

if (existsSync(keyPath)) {
  console.error(
    `Une clé existe déjà : ${keyPath}\n` +
      "La régénérer casserait la mise à jour de toutes les installations existantes.\n" +
      "Supprime le fichier à la main si c'est vraiment ce que tu veux.",
  );
  process.exit(1);
}
mkdirSync(keyDir, { recursive: true });

// `tauri signer generate` écrit <path> (privée) et <path>.pub (publique).
// -w écrase, --password "" produit une clé sans mot de passe : indispensable
// pour une signature non interactive en CI.
console.log("Génération de la paire de clés…");
execFileSync("npx", ["tauri", "signer", "generate", "-w", keyPath, "--password", ""], {
  cwd: root,
  stdio: "inherit",
});

const pubkey = readFileSync(`${keyPath}.pub`, "utf8").trim();
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.plugins ??= {};
conf.plugins.updater ??= {};
conf.plugins.updater.pubkey = pubkey;
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);

console.log(`
✅ Clé publique inscrite dans src-tauri/tauri.conf.json (à committer).
🔒 Clé privée : ${keyPath}  — NE JAMAIS committer.

Étape suivante — ajoute les secrets au dépôt Oneil974/lumen-assistant :
  gh secret set TAURI_SIGNING_PRIVATE_KEY < ${keyPath}
  gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body ""
`);
