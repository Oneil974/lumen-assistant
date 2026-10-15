#!/usr/bin/env node
/**
 * Rafraîchit les applications INSTALLÉES sur ce poste à partir des sources.
 *
 *   npm run apps:install-local            # toutes les apps déjà installées
 *   npm run apps:install-local -- etl kanban
 *   npm run apps:reinstall                # TOUTES les apps des sources (--every),
 *                                         # installées ou non : repart de zéro
 *
 * En 0.2, une app ouverte par Lumen n'est pas `src/<app>/…` mais la copie que
 * le Catalogue a dépaquetée dans le dossier de données (`apps/<id>/`), avec SA
 * copie des libs partagées (ai-prompt.js, icons.js, apps-i18n.js…). Modifier
 * les sources ne change donc rien à l'écran tant que le paquet installé n'a
 * pas été remplacé — et le circuit normal (publier, puis mettre à jour depuis
 * le Catalogue) ne se déclenche que sur changement de version.
 *
 * Ce script fait en une commande ce qu'on faisait à la main : fabriquer les
 * paquets (package-apps.mjs), dépaqueter chacun par-dessus l'installation
 * existante, et réaligner le registre `_index.json` sur les manifestes. Il ne
 * touche qu'aux apps DÉJÀ installées (sauf `--all`) : installer, c'est le
 * travail du Catalogue.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_DIR = "com.lumen.app"; // cf. src-tauri/src/paths.rs (SHARED_DIR)

/** Dossier de données de Lumen, comme `paths::shared_data_dir` côté Rust. */
function dataDir() {
  if (process.env.LUMEN_DATA_DIR) return process.env.LUMEN_DATA_DIR;
  const os = platform();
  if (os === "darwin") return join(homedir(), "Library", "Application Support", SHARED_DIR);
  if (os === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), SHARED_DIR);
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), SHARED_DIR);
}

const args = process.argv.slice(2);
const every = args.includes("--every");
const all = args.includes("--all") || every;
const only = args.filter((a) => !a.startsWith("--"));

const appsDir = join(dataDir(), "apps");
if (every) mkdirSync(appsDir, { recursive: true });
if (!existsSync(appsDir)) {
  console.error(`Aucune app installée : ${appsDir} n'existe pas. Installez d'abord depuis le Catalogue.`);
  process.exit(1);
}
const { PACKAGES: ALL_PACKAGES, RETIRED } = await import("./app-packages.mjs");
// Apps retirées : on les désinstalle (comme Lumen au démarrage) au lieu
// d'essayer de les réempaqueter — leurs sources n'existent plus.
for (const id of RETIRED) {
  if (existsSync(join(appsDir, id, "manifest.json"))) {
    rmSync(join(appsDir, id), { recursive: true, force: true });
    console.log(`  − ${id} retirée (désinstallée)`);
  }
}
const installed = readdirSync(appsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(appsDir, d.name, "manifest.json")))
  .map((d) => d.name);

// --every : toutes les apps définies dans les sources (scripts/app-packages.mjs),
// qu'elles soient installées ou non — une réinstallation complète.
const PACKAGES = every ? ALL_PACKAGES : [];
const targets = only.length ? only : every ? PACKAGES.map((p) => p.id) : installed;
if (!targets.length) {
  console.error("Aucune app à installer.");
  process.exit(1);
}
if (every) console.log(`Réinstallation de ${targets.length} app(s) depuis les sources…`);
const missing = targets.filter((id) => !installed.includes(id));
if (missing.length && !all) {
  console.error(`Pas installée(s) sur ce poste : ${missing.join(", ")} — installez-les depuis le Catalogue (ou passez --all).`);
  process.exit(1);
}

// 1. Paquets frais, dans un dossier temporaire : dist/apps reste ce que
//    publish-apps.sh y a mis.
const out = join(tmpdir(), `lumen-apps-local-${process.pid}`);
mkdirSync(out, { recursive: true });
try {
  execFileSync(process.execPath, [join(ROOT, "scripts", "package-apps.mjs"), "--out", out, ...targets], { stdio: "inherit", cwd: ROOT });
} catch {
  console.error("Empaquetage en échec : rien n'a été installé.");
  rmSync(out, { recursive: true, force: true });
  process.exit(1);
}

// 2. Dépaquetage par-dessus l'installation : on remplace le dossier ENTIER,
//    pas fichier par fichier, sinon un fichier retiré des sources survivrait.
let done = 0;
for (const id of targets) {
  const pkg = join(out, `${id}.lumenapp`);
  if (!existsSync(pkg)) { console.error(`  ✗ ${id} : paquet absent`); continue; }
  const staging = join(appsDir, `${id}.new`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    execFileSync("unzip", ["-q", "-o", pkg, "-d", staging], { stdio: "inherit" });
  } catch {
    console.error(`  ✗ ${id} : dépaquetage en échec (unzip)`);
    rmSync(staging, { recursive: true, force: true });
    continue;
  }
  const dest = join(appsDir, id);
  rmSync(dest, { recursive: true, force: true });
  renameSync(staging, dest);
  console.log(`  ✓ ${id} installée`);
  done++;
}
rmSync(out, { recursive: true, force: true });

// 3. Le registre du Catalogue (icône, description, dimensions…) doit refléter
//    les manifestes dépaquetés, sinon le bureau garde l'ancienne fiche.
const indexPath = join(appsDir, "_index.json");
if (existsSync(indexPath)) {
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  if (Array.isArray(index.apps)) index.apps = index.apps.filter((e) => !RETIRED.includes(e.id));
  else if (Array.isArray(index)) index.splice(0, index.length, ...index.filter((e) => !RETIRED.includes(e.id)));
  else if (index.apps) for (const id of RETIRED) delete index.apps[id];
  const list = Array.isArray(index) ? index : Array.isArray(index.apps) ? index.apps : Object.values(index.apps || {});
  for (const id of targets) {
    if (list.some(entry => entry.id === id)) continue;
    const mp = join(appsDir, id, "manifest.json");
    if (existsSync(mp)) {
      const entry = JSON.parse(readFileSync(mp, "utf8"));
      list.push(entry);
      if (!Array.isArray(index) && !Array.isArray(index.apps)) index.apps[id] = entry;
    }
  }
  for (const entry of list) {
    const mp = join(appsDir, entry.id || "", "manifest.json");
    if (!entry.id || !existsSync(mp)) continue;
    const m = JSON.parse(readFileSync(mp, "utf8"));
    for (const k of ["name", "description", "icon", "gradient", "capabilities", "entry", "width", "height", "version", "pro", "category", "trust", "minLumen", "tabs", "intents", "xr"]) {
      if (k in m) entry[k] = m[k];
    }
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

console.log(`\n${done}/${targets.length} app(s) rafraîchie(s) dans ${appsDir}. Rouvrez les fenêtres concernées dans Lumen.`);
