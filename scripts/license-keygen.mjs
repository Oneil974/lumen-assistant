#!/usr/bin/env node
// Génère la paire de clés d'émission des licences Lumen Pro. À exécuter UNE
// fois, sur un poste de confiance.
//
// La moitié PUBLIQUE se colle dans src-tauri/src/license.rs (ISSUER_PUBLIC_KEY).
// La moitié PRIVÉE ne doit jamais entrer dans le dépôt : elle seule permet
// d'émettre des clés, et le dépôt est public. Le fichier est donc écrit hors de
// l'arborescence du projet, dans ~/.lumen-license/, avec les droits 0600.
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".lumen-license");
const priv = join(dir, "issuer.pem");
if (existsSync(priv) && !process.argv.includes("--force")) {
  console.error(`Une clé existe déjà : ${priv}\nRelancez avec --force pour l'écraser (toutes les licences émises deviendront invalides).`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

// Le DER SPKI d'une clé Ed25519 fait 44 octets dont les 32 derniers sont la clé
// brute — c'est cette forme brute qu'attend ed25519_dalek::VerifyingKey.
const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);

console.log(`Clé privée écrite dans ${priv} (à sauvegarder hors ligne).\n`);
console.log("Collez cette ligne dans src-tauri/src/license.rs :\n");
console.log(`const ISSUER_PUBLIC_KEY: &str = "${raw.toString("base64url")}";`);
