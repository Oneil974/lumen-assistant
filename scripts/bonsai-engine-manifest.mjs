#!/usr/bin/env node
// Met à jour dist/bonsai-engine/bonsai-engine.json avec l'archive d'une cible :
//   node scripts/bonsai-engine-manifest.mjs <cible> <archive.zip> <version>
//
// Le manifeste est MULTI-PLATEFORME (une entrée par cible), alors que chaque
// machine ne construit que la sienne : on repart du manifeste publié
// (GitHub Pages) s'il existe, sinon du fichier local, et on remplace l'entrée.
// L'URL pointe vers la Release GitHub où publish-bonsai-engine.sh dépose
// l'archive ; c'est cette URL que src-tauri/src/bonsai.rs télécharge.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [target, zip, version] = process.argv.slice(2);
if (!target || !zip || !version) {
  console.error("usage: bonsai-engine-manifest.mjs <cible> <archive.zip> <version>");
  process.exit(2);
}
export const MANIFEST_URL = "https://oneil974.github.io/lumen-apps/bonsai-engine.json";
export const RELEASE_REPO = "Oneil974/lumen-app";
export const RELEASE_TAG = "bonsai-engine";

const out = resolve(ROOT, "dist/bonsai-engine/bonsai-engine.json");
// Les entrées des AUTRES cibles sont réunies depuis toutes les copies connues :
// manifeste publié (Pages), clone lumen-apps (../lumen-apps ou LUMEN_APPS_REPO)
// et fichier local. Une seule source ferait perdre une plateforme dès qu'elle
// manque à l'appel — c'est arrivé quand publish-apps.sh a effacé le manifeste
// en ligne : la build suivante l'aurait republié avec sa seule cible.
const repoCopy = resolve(process.env.LUMEN_APPS_REPO || resolve(ROOT, "../lumen-apps"), "bonsai-engine.json");
const manifest = { targets: {} };
function merge(source) {
  if (!source?.targets) return;
  for (const [t, entry] of Object.entries(source.targets)) {
    const cur = manifest.targets[t];
    // À cible égale, la plus récente l'emporte (les versions sont datées).
    if (!cur || String(entry.version || "") > String(cur.version || "")) manifest.targets[t] = entry;
  }
}
for (const file of [out, repoCopy]) {
  if (!existsSync(file)) continue;
  try { merge(JSON.parse(readFileSync(file, "utf8"))); } catch { /* fichier illisible : ignoré */ }
}
try {
  const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(8000) });
  if (res.ok) merge(await res.json());
} catch { /* hors ligne : copies locales */ }

// Une Release GitHub refuse tout asset de 2 Gio ou plus (HTTP 422 « size must
// be less than 2147483648 »). L'archive CUDA (torch + bibliothèques NVIDIA,
// ~3 Go) est donc DÉCOUPÉE en tranches `<archive>.part1`, `.part2`… publiées
// comme autant d'assets ; Lumen (bonsai.rs) les télécharge dans l'ordre, les
// recolle et vérifie l'empreinte de l'ensemble. Sous la limite, l'archive
// reste d'un seul tenant — le cas macOS, 123 Mo.
//
// Une SEULE lecture de l'archive produit les tranches, leurs empreintes et
// celle de l'ensemble : sur un partage réseau (build Windows depuis le dossier
// du Mac), la relire pour l'empreinte doublait un passage déjà long, et une
// interruption laissait des tranches neuves à côté d'un manifeste périmé.
const PART_SIZE = 1900 * 1024 * 1024;
async function splitAndHash(file) {
  const total = statSync(file).size;
  const whole = createHash("sha256");
  if (total < 2 * 1024 * 1024 * 1024) {
    for await (const chunk of createReadStream(file)) whole.update(chunk);
    return { sha256: whole.digest("hex"), parts: null };
  }
  const parts = [];
  for (let i = 0, start = 0; start < total; i++, start += PART_SIZE) {
    const end = Math.min(start + PART_SIZE, total) - 1;
    const partFile = `${file}.part${i + 1}`;
    const partHash = createHash("sha256");
    // Toujours réécrite : une tranche de même taille peut venir d'une archive
    // précédente (la première fait toujours exactement PART_SIZE).
    const sink = createWriteStream(partFile);
    for await (const chunk of createReadStream(file, { start, end })) {
      whole.update(chunk);
      partHash.update(chunk);
      if (!sink.write(chunk)) await new Promise((r) => sink.once("drain", r));
    }
    await new Promise((res, rej) => sink.end((e) => (e ? rej(e) : res())));
    parts.push({
      file: basename(partFile),
      url: `https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/${basename(partFile)}`,
      size: end - start + 1,
      sha256: partHash.digest("hex"),
    });
    console.log(`  tranche ${i + 1} : ${basename(partFile)} (${((end - start + 1) / 1e6).toFixed(0)} Mo)`);
  }
  return { sha256: whole.digest("hex"), parts };
}

const { sha256, parts } = await splitAndHash(zip);
const entry = {
  version,
  file: basename(zip),
  size: statSync(zip).size,
  sha256,
  updated: new Date().toISOString().slice(0, 10),
};
// `url` = archive d'un seul tenant ; `parts` = tranches à recoller. Jamais les
// deux : une entrée en tranches sans `url` est vue comme « indisponible » par
// une version de Lumen antérieure au découpage, plutôt que téléchargée à moitié.
if (parts) entry.parts = parts;
else entry.url = `https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/${basename(zip)}`;
manifest.targets[target] = entry;
manifest.updated = new Date().toISOString().slice(0, 10);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`✓ ${out} : ${target} → ${entry.file} (${(entry.size / 1e6).toFixed(0)} Mo${parts ? `, ${parts.length} tranches` : ""})`);
