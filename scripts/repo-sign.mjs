#!/usr/bin/env node
/**
 * Signe l'index d'un dépôt d'applications.
 *
 *   node scripts/repo-keygen.mjs            # une fois
 *   node scripts/repo-sign.mjs dist/apps/index.json
 *
 * La signature ne porte PAS sur le texte JSON de l'index, mais sur une forme
 * canonique reconstruite des deux côtés : une ligne `id|version|sha256` par
 * application, triée par identifiant. Signer le JSON brut aurait paru plus
 * simple et aurait été un piège — Node et Rust n'ordonnent pas les clés, ni
 * n'échappent l'Unicode, de la même façon, et une signature qui ne vérifie que
 * par chance ne vérifie rien.
 *
 * Ce qui est ainsi couvert : quelles applications le dépôt propose, en quelle
 * version, et — par leur empreinte — quels octets exactement. Une URL réécrite
 * ne sert à rien à un attaquant, puisque le paquet servi devra malgré tout
 * correspondre à l'empreinte signée.
 *
 * Sans index signé, Lumen installe quand même (empreinte SHA-256 + HTTPS) mais
 * affiche « dépôt non vérifié » — parce que c'est le cas.
 */
import { createPrivateKey, sign, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = join(homedir(), ".lumen-license");
const keyPath = join(dir, "repo.pem");

if (process.argv.includes("--keygen")) {
  if (existsSync(keyPath) && !process.argv.includes("--force")) {
    console.error(`Une clé de dépôt existe déjà : ${keyPath} (--force pour l'écraser).`);
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  console.log(`Clé de dépôt écrite dans ${keyPath}.\n`);
  console.log("Collez cette ligne dans src-tauri/src/appstore.rs :\n");
  console.log(`const REPO_PUBLIC_KEY: &str = "${raw.toString("base64url")}";`);
  process.exit(0);
}

const target = process.argv[2];
if (!target) {
  console.error("Usage : node scripts/repo-sign.mjs dist/apps/index.json   (ou --keygen)");
  process.exit(1);
}

let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(keyPath));
} catch {
  console.error(`Clé de dépôt introuvable (${keyPath}). Lancez d'abord : node scripts/repo-sign.mjs --keygen`);
  process.exit(1);
}

const index = JSON.parse(readFileSync(target, "utf8"));
const canonical = [...(index.apps || [])]
  .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  .map((a) => `${a.id}|${a.version}|${String(a.sha256).toLowerCase()}`)
  .join("\n");
index.signature = sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url");
writeFileSync(target, JSON.stringify(index, null, 2));
console.log(`Index signé : ${target}`);
