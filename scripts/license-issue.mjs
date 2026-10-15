#!/usr/bin/env node
// Émet une clé de licence Lumen Pro.
//
//   node scripts/license-issue.mjs "Nom du client" [--days 365]
//
// La clé produite est autoportante : le binaire la vérifie hors ligne avec la
// clé publique qu'il embarque. Rien à enregistrer nulle part côté serveur — ce
// qui veut aussi dire qu'une clé émise ne peut pas être révoquée. Pour un
// abonnement, émettez une clé à durée limitée (--days) plutôt qu'une perpétuelle.
import { createPrivateKey, sign, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const holder = args.find((a) => !a.startsWith("--"));
if (!holder) {
  console.error('Usage : node scripts/license-issue.mjs "Nom du client" [--days 365]');
  process.exit(1);
}
const daysIdx = args.indexOf("--days");
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 0;
if (daysIdx >= 0 && (!Number.isFinite(days) || days <= 0)) {
  console.error("--days attend un nombre de jours positif.");
  process.exit(1);
}

const keyPath = join(homedir(), ".lumen-license", "issuer.pem");
let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(keyPath));
} catch {
  console.error(`Clé d'émission introuvable (${keyPath}). Lancez d'abord scripts/license-keygen.mjs.`);
  process.exit(1);
}

const iat = Math.floor(Date.now() / 1000);
const claims = { id: randomUUID(), holder, plan: "pro", iat, exp: days ? iat + days * 86400 : null };

// On signe le payload TEL QU'ENCODÉ, pas l'objet : c'est exactement la chaîne
// que le binaire vérifiera, sans re-sérialisation possible entre les deux.
const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
const signature = sign(null, Buffer.from(payload), privateKey).toString("base64url");

console.log(`Licence pour « ${holder} »${days ? ` — valable ${days} jours` : " — perpétuelle"}\n`);
console.log(`LUMEN-PRO.${payload}.${signature}`);
