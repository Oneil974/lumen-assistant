#!/usr/bin/env node
// Assemble un manifeste `latest.json` à partir des artefacts d'updater produits
// par `tauri build`, puis (optionnellement) publie le tout sur le dépôt public.
//
//   node scripts/release.mjs            # écrit dist/release/ et s'arrête
//   node scripts/release.mjs --publish  # + crée la release GitHub via `gh`
//
// Pourquoi un script plutôt qu'une action GitHub : la source de Lumen n'est pas
// publiée. Les binaires sont construits ici, sur les machines de dev, puis
// déposés sur Oneil974/lumen-assistant (site + binaires uniquement). Le manifeste
// `latest.json` est ce que l'updater interroge — il DOIT accompagner chaque
// release, sans quoi les installations existantes ne verront jamais la
// nouvelle version.
//
// Prérequis : TAURI_SIGNING_PRIVATE_KEY renseignée pendant `tauri build`
// (sinon aucun fichier .sig n'est produit et ce script échoue en le disant).

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const outDir = join(root, "dist", "release");
const repo = "Oneil974/lumen-assistant";

if (!conf.plugins?.updater?.pubkey) {
  console.error(
    "tauri.conf.json n'a pas de clé publique d'updater.\n" +
      "Lance d'abord : node scripts/setup-updater.mjs",
  );
  process.exit(1);
}

// Édition Pro : mêmes artefacts, autre MANIFESTE. L'édition Pro interroge
// `latest-pro.json` (cf. src-tauri/tauri.pro.conf.json) — sans quoi elle se
// mettrait à jour avec le binaire standard et perdrait ses applications métier.
// Les deux manifestes vivent sur la MÊME release : `releases/latest/download/…`
// désigne la dernière release du dépôt, pas la dernière de chaque canal.
const PRO = process.argv.includes("--pro");
const manifestName = PRO ? "latest-pro.json" : "latest.json";
const product = PRO ? "Lumen Pro" : "Lumen";

// Chaque artefact signé produit un `<fichier>.sig` à côté de lui. On part des
// .sig : c'est la preuve qu'une signature existe, et le nom donne l'artefact.
function findSignatures(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findSignatures(p, acc);
    // `._*` : doublons AppleDouble que macOS sème sur le disque exFAT. Ils
    // finissaient dans la release, renommés `default._…` par GitHub.
    else if (e.name.endsWith(".sig") && !e.name.startsWith("._")) acc.push(p);
  }
  return acc;
}

/**
 * Déduit la clé de plateforme attendue par l'updater Tauri à partir du chemin
 * de l'artefact. Retourne null si le format n'est pas un format d'update
 * (un .dmg, par exemple, n'est PAS installable par l'updater).
 */
function platformKey(path) {
  const p = path.toLowerCase();
  let arm = /aarch64|arm64/.test(p);
  // Le bundle macOS ne porte pas l'architecture dans son nom : sans marqueur,
  // c'est celle de la machine de build (Apple Silicon → aarch64).
  if (p.includes(".app.tar.gz")) {
    if (!arm && !/x86_64|x64/.test(p)) arm = process.arch === "arm64";
    return arm ? "darwin-aarch64" : "darwin-x86_64";
  }
  if (p.includes(".appimage")) return arm ? "linux-aarch64" : "linux-x86_64";
  if (p.includes("-setup.exe") || p.includes(".msi")) return arm ? "windows-aarch64" : "windows-x86_64";
  return null;
}

// Dossier `target` réel de cargo : `.cargo/config.toml` le déporte
// (target-dir = /Volumes/LiquidBuild/…), et `src-tauri/target` n'est alors
// qu'un vestige — sans cette lecture, aucun artefact n'était trouvé.
function cargoTargetDir() {
  try {
    const meta = JSON.parse(
      execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: join(root, "src-tauri"), encoding: "utf8" }),
    );
    if (meta.target_directory) return meta.target_directory;
  } catch {}
  return join(root, "src-tauri", "target");
}
const targetDir = cargoTargetDir();
const bundleDirs = [
  join(targetDir, "release", "bundle"),
  join(targetDir, "universal-apple-darwin", "release", "bundle"),
  join(targetDir, "aarch64-apple-darwin", "release", "bundle"),
  join(root, "src-tauri", "target", "release", "bundle"),
];

/**
 * Vrai si l'artefact appartient à l'édition qu'on publie. Les deux éditions
 * partagent le dossier `bundle/` : « Lumen Pro.app.tar.gz » et
 * « Lumen.app.tar.gz » s'y côtoient, et rien dans leur extension ne les
 * distingue. Le NOM est le seul discriminant — d'où ce filtre, sans lequel le
 * manifeste d'un canal pouvait pointer vers le binaire de l'autre : les
 * utilisateurs de l'édition standard auraient reçu Lumen Pro à la mise à jour
 * suivante, ou le contraire.
 */
function belongsToEdition(artifact) {
  const name = artifact.split("/").pop();
  // `\b` ne convient pas : l'underscore est un caractère de mot, donc il n'y a
  // pas de frontière entre « Pro » et « _0.1.1 ». On exige simplement que rien
  // d'alphanumérique ne suive.
  const isPro = /^Lumen[ _]Pro(?![A-Za-z0-9])/.test(name);
  return PRO ? isPro : !isPro;
}

const platforms = {};
const assets = [];
// Deux formats Windows signés (NSIS et MSI) : l'updater n'en retient qu'un
// par plateforme. On préfère l'installeur NSIS (`-setup.exe`, recommandé par
// Tauri), mais les DEUX fichiers sont joints à la release.
const allSigs = bundleDirs.flatMap((dir) => findSignatures(dir));
allSigs.sort((a, b) => (a.toLowerCase().includes("-setup.exe") ? 0 : 1) - (b.toLowerCase().includes("-setup.exe") ? 0 : 1));
for (const dir of [null]) {
  for (const sig of allSigs) {
    const artifact = sig.slice(0, -4);
    const key = platformKey(artifact);
    if (!key) continue;
    if (!belongsToEdition(artifact)) continue;
    // Un artefact numéroté d'une AUTRE version (bundle/remote/ garde les
    // anciens rapatriements) ne doit ni entrer dans latest.json ni partir.
    const vm = artifact.split("/").pop().match(/_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)_/);
    if (vm && vm[1] !== version) continue;
    if (platforms[key]) {
      console.warn(`⚠️  Deux artefacts pour ${key} — ${artifact.split("/").pop()} est joint à la release mais latest.json pointe sur le premier.`);
      assets.push(artifact);
      continue;
    }
    const name = artifact.split("/").pop();
    platforms[key] = {
      signature: readFileSync(sig, "utf8").trim(),
      url: `https://github.com/${repo}/releases/download/v${version}/${name}`,
    };
    assets.push(artifact);
  }
}

if (!Object.keys(platforms).length) {
  console.error(
    `Aucun artefact signé trouvé pour ${product}.\n` +
      "Construis d'abord avec la clé de signature en environnement :\n" +
      '  TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.lumen/updater.key)" \\\n' +
      '  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri build',
  );
  process.exit(1);
}

// `notes` alimente le corps affiché par l'updater : on prend le CHANGELOG s'il
// existe, sinon un texte neutre.
let notes = `${product} ${version}`;
try {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const section = changelog.split(/^## /m).find((s) => s.startsWith(version));
  if (section) notes = section.slice(version.length).trim();
} catch {}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

mkdirSync(outDir, { recursive: true });
// dist/release/ ne garde QUE la release en cours : sans ce ménage, les
// artefacts d'une version précédente (et les `._*`) restaient dans le dossier
// et partaient dans la nouvelle release GitHub.
for (const f of readdirSync(outDir)) {
  const other = f === (PRO ? "latest.json" : "latest-pro.json");
  if (!other) rmSync(join(outDir, f), { force: true, recursive: true });
}
writeFileSync(join(outDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
for (const a of assets) {
  copyFileSync(a, join(outDir, a.split("/").pop()));
  copyFileSync(`${a}.sig`, join(outDir, `${a.split("/").pop()}.sig`));
}

// Installeurs de première installation (absents de latest.json) : DMG
// notarisé, .deb Linux et Raspberry Pi, .rpm — et, pour l'instant, les
// AppImage/.exe/.msi NON SIGNÉS de la version (téléchargeables, mais pas
// proposés par l'updater, qui exige une signature). Un fichier déjà retenu
// comme artefact signé n'est pas compté deux fois (même nom).
// Sans eux, la release n'offrait aux nouveaux utilisateurs Mac et Pi qu'une
// archive d'updater.
const installers = [];
const findInstallers = (dir, depth = 0) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth < 4) findInstallers(p, depth + 1);
    else if (!e.name.startsWith("._") && /\.(dmg|deb|rpm|appimage|exe|msi)$/i.test(e.name) && e.name.includes(`_${version}_`)
      && belongsToEdition(p) && !installers.some((x) => x.split("/").pop() === e.name)) installers.push(p);
  }
};
findInstallers(join(root, "dist", "builds"));
for (const f of readdirSync(join(root, "dist"))) if (/\.dmg$/i.test(f) && !f.startsWith("._") && f.includes(`_${version}_`) && !installers.some((x) => x.endsWith(`/${f}`))) installers.push(join(root, "dist", f));
for (const i of installers) copyFileSync(i, join(outDir, i.split("/").pop()));
if (installers.length) console.log(`Installeurs joints : ${installers.map((i) => i.split("/").pop()).join(", ")}`);

console.log(`Version ${version} — plateformes : ${Object.keys(platforms).join(", ")}`);
console.log(`Artefacts rassemblés dans ${outDir}`);

if (!process.argv.includes("--publish")) {
  console.log(`
Pour publier :
  node scripts/release.mjs --publish          # édition standard
  node scripts/release.mjs --pro --publish    # édition Pro (ajoute latest-pro.json à la release de la version)
`);
  process.exit(0);
}

console.log(`Publication de ${product} v${version} sur ${repo}…`);
// Le dépôt public a changé de nom (lumen-app → lumen-assistant) : tant que le
// renommage n'est pas fait côté GitHub, `gh` répond 404 sans plus d'explication.
try {
  execFileSync("gh", ["repo", "view", repo, "--json", "name"], { stdio: "pipe" });
} catch {
  console.error(
    `Le dépôt ${repo} n'existe pas (ou gh n'y a pas accès).\n` +
      "Si le dépôt s'appelle encore lumen-app, renomme-le :\n" +
      `  gh repo rename ${repo.split("/")[1]} -R Oneil974/lumen-app\n` +
      "(GitHub redirige l'ancien nom ; les binaires 0.2.0 interrogent déjà l'endpoint lumen-assistant.)",
  );
  process.exit(1);
}
// Filet : rien d'autre que le manifeste et les artefacts de CETTE version.
const unversioned = /^Lumen( Pro)?\.app\.tar\.gz(\.sig)?$/;
const files = readdirSync(outDir)
  .filter((f) => !f.startsWith("._") && f !== ".DS_Store")
  .filter((f) => f === "latest.json" || f === "latest-pro.json" || unversioned.test(f) || f.includes(`_${version}_`))
  .map((f) => join(outDir, f));
const skipped = readdirSync(outDir).filter((f) => !files.includes(join(outDir, f)));
if (skipped.length) console.log(`Ignorés (autre version ou parasites) : ${skipped.join(", ")}`);
// L'édition Pro s'ajoute à la release de la version (elle ne crée pas la
// sienne) : les deux manifestes doivent être servis par la MÊME release pour
// que `releases/latest/download/…` reste valable des deux côtés.
if (PRO) {
  execFileSync("gh", ["release", "upload", `v${version}`, "--repo", repo, "--clobber", ...files], { stdio: "inherit" });
} else {
  execFileSync(
    "gh",
    [
      "release", "create", `v${version}`,
      "--repo", repo,
      "--title", `Lumen ${version}`,
      "--notes", notes,
      ...files,
    ],
    { stdio: "inherit" },
  );
}
console.log(`✅ Publié. L'updater lira https://github.com/${repo}/releases/latest/download/${manifestName}`);
