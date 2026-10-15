#!/usr/bin/env node
/**
 * Fabrique les paquets `.lumenapp` et l'index du dépôt.
 *
 *   node scripts/package-apps.mjs [--out dist/apps] [--base https://…/apps/] [--exclude id,id] [id …]
 *
 * Un paquet est une archive ZIP dont l'arborescence REPRODUIT celle de `src/`.
 * Ce choix n'est pas cosmétique : les applications de Lumen se référencent entre
 * elles par des chemins relatifs (`../lib/ui.css`, `../llm.js`). Reproduire la
 * hiérarchie fait que tout continue de résoudre, sans réécrire une seule URL —
 * et une URL réécrite à la main est une URL qu'on oublie de réécrire un jour.
 *
 * Le contenu d'un paquet est calculé, pas déclaré : on part du point d'entrée et
 * on suit les dépendances (imports, `src`, `href`, `import()` littéraux). Une
 * liste de fichiers écrite à la main se périme au premier import ajouté, et le
 * symptôme — une app installée qui s'ouvre sur un écran blanc — ne dit rien de
 * la cause.
 *
 * Ce que le suiveur ne voit pas : les URL construites à l'exécution
 * (`"/icons/" + name + ".svg"`). Les dossiers d'assets concernés sont donc
 * embarqués en entier, via `assets` — cf. ASSET_DIRS.
 *
 * RÉVISIONS — `version` d'un paquet = `<version de Lumen>-r<n>`. On prend
 * l'empreinte de chaque fichier embarqué et on la compare à la dernière
 * publication (`--previous <index.json publié>`, et `revs.json` à côté) : si
 * un seul fichier a changé, `n` augmente. Lumen compare la version installée
 * à celle du dépôt : il propose donc la mise à jour dès qu'un fichier bouge,
 * et seulement dans ce cas. `changes` résume ce qui a changé (Catalogue).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, cpSync, statSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { collectDependencies } from "./frontend-dependencies.mjs";
import { PACKAGES, CORE_APPS } from "./app-packages.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** Toujours embarqué : le socle visuel et les ponts de l'AppKit. */
const ALWAYS = [
  "lib/tokens.css", "lib/ui.css", "lib/flat.css", "lib/app-shell.css",
  "lib/icons.js", "lib/theme-init.js",
  "lib/appkit/guest.js", "lib/appkit/tauri-shim.js",
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = resolve(ROOT, flag("out", "dist/apps"));
const baseUrl = flag("base", "");
// Paquets tenus HORS de l'index (ex. village, 39 Mo d'assets : trop lourd pour
// GitHub Pages — il sera diffusé par une Release). L'index reste complet vis-à-vis
// de ce qu'on a DÉCIDÉ de publier, pas de ce qui existe dans le code.
const excluded = new Set(flag("exclude", "").split(",").map((s) => s.trim()).filter(Boolean));
const previousPath = flag("previous", join(outDir, "index.json"));
const baseVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const previousIndex = readJson(previousPath);
const previousById = new Map((previousIndex?.apps || []).map((a) => [a.id, a]));
// Empreintes fichier par fichier de la dernière publication (pour décrire les changements).
const previousRevs = readJson(join(dirname(previousPath), "revs.json")) || readJson(join(outDir, "revs.json")) || { apps: {} };
const nextRevs = { generated: new Date().toISOString(), apps: { ...previousRevs.apps } };
const only = args.filter((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));

/* ---- Empreintes ---------------------------------------------------------- */

const shortHash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
const hashOfFiles = (files) => createHash("sha256").update(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}:${v}`).join("\n")).digest("hex");
function hashDir(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      // Hash exactly the files included by zip, including on exFAT.
      if (name.startsWith("._") || name === ".DS_Store") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p).split("\\").join("/")] = shortHash(readFileSync(p));
    }
  };
  walk(root);
  return out;
}
/** Empreintes d'un paquet DÉJÀ publié (index sans empreinte, d'avant les révisions). */
function hashesOfArchive(archive) {
  const tmp = join(outDir, `.prev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    mkdirSync(tmp, { recursive: true });
    execFileSync("unzip", ["-q", "-o", archive, "-d", tmp]);
    const files = hashDir(tmp);
    const m = JSON.parse(readFileSync(join(tmp, "manifest.json"), "utf8"));
    files["manifest.json"] = shortHash(JSON.stringify({ ...m, version: "" }));
    return files;
  } catch { return null; } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/* ---- Suivi des dépendances ---------------------------------------------- */

/* ---- Fabrication d'un paquet -------------------------------------------- */

function manifestOf(pkg, entry, version = baseVersion) {
  return {
    id: pkg.id,
    name: pkg.name,
    version,
    description: pkg.description || "",
    category: pkg.category || "create",
    entry,
    capabilities: pkg.capabilities || [],
    gradient: pkg.gradient || [],
    icon: pkg.icon || "",
    width: pkg.width || 1120,
    height: pkg.height || 780,
    // Plus d'apps réservées à une licence : le champ reste pour les anciens bureaux.
    pro: false,
    // Pack facultatif (loisirs, robotique, ml…) et prérequis annoncés avant installation.
    ...(pkg.pack ? { pack: pkg.pack } : {}),
    ...(pkg.prerequisites ? { prerequisites: pkg.prerequisites } : {}),
    // Les paquets du catalogue officiel SONT les fichiers qui vivaient dans le
    // bundle : leur accorder moins qu'avant ne les rendrait pas plus sûrs, ça
    // les casserait. Une app venue d'ailleurs, elle, n'obtient jamais ce niveau.
    trust: pkg.trust || "first-party",
    minLumen: "0.2.0",
    ...(pkg.tabs ? { tabs: pkg.tabs } : {}),
    // App Intents promues à l'assistant (cf. lib/appkit/host.js).
    ...(pkg.intents ? { intents: pkg.intents } : {}),
    ...(pkg.xr ? { xr: pkg.xr } : {}),
  };
}

function build(pkg) {
  if (CORE_APPS.includes(pkg.id)) {
    throw new Error(`« ${pkg.id} » fait partie du noyau : il ne doit pas être packagé.`);
  }
  const staging = join(outDir, `.staging-${pkg.id}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // Un hub reçoit la coquille générique, posée à `<id>/hub.html` pour que ses
  // onglets (`../notes/notes.html`) résolvent comme dans le bundle.
  let entry;
  const entries = [...ALWAYS];
  if (pkg.tabs) {
    entry = `${pkg.id}/hub.html`;
    mkdirSync(join(staging, pkg.id), { recursive: true });
    cpSync(join(SRC, "lib/appkit/hub-shell.html"), join(staging, entry));
    for (const tab of pkg.tabs) {
      const rel = posix.normalize(posix.join(pkg.id, tab.url));
      if (!existsSync(join(SRC, rel))) throw new Error(`onglet introuvable : ${rel}`);
      entries.push(rel);
    }
  } else {
    entry = pkg.entry;
    if (!existsSync(join(SRC, entry))) throw new Error(`point d'entrée introuvable : ${entry}`);
    entries.push(entry);
  }

  const { files, assetDirs } = collectDependencies(SRC, entries);
  for (const rel of files) {
    const dest = join(staging, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(SRC, rel), dest);
  }
  for (const dir of assetDirs) {
    cpSync(join(SRC, dir), join(staging, dir), {
      recursive: true,
      // Les `._*` d'AppleDouble et les `.DS_Store` n'ont rien à faire dans un
      // paquet distribué. Les écarter ici plutôt qu'à l'emballage garde aussi
      // le décompte de fichiers honnête.
      filter: (src) => !/(^|\/)(\._|\.DS_Store$)/.test(src),
    });
  }

  // ---- Révision : empreinte du contenu, comparée à la dernière publication ----
  const fileHashes = hashDir(staging);
  // Le manifeste (sans sa version) fait partie du contenu : une capacité ou une
  // intention ajoutée doit, elle aussi, déclencher une mise à jour.
  fileHashes["manifest.json"] = shortHash(JSON.stringify({ ...manifestOf(pkg, entry, "") }));
  const contentHash = hashOfFiles(fileHashes);
  const prev = previousById.get(pkg.id);
  // Index publié avant les révisions : empreinte de référence tirée de l'archive.
  let legacyFiles = null;
  if (prev && !prev.contentHash) {
    const archivePrev = join(dirname(previousPath), `${pkg.id}.lumenapp`);
    legacyFiles = existsSync(archivePrev) ? hashesOfArchive(archivePrev) : null;
    if (legacyFiles) prev.contentHash = hashOfFiles(legacyFiles);
  }
  const prevRev = Number.isInteger(prev?.rev) ? prev.rev : null;
  const sameBase = prev && String(prev.version || "").split("-r")[0] === baseVersion;
  let rev, updated, changes;
  if (prev && sameBase && prev.contentHash === contentHash) {
    rev = prevRev ?? 0; updated = prev.updated || null; changes = prev.changes || "";
  } else {
    rev = !prev ? 0 : sameBase ? (prevRev ?? 0) + 1 : 0;
    updated = new Date().toISOString();
    const old = previousRevs.apps?.[pkg.id]?.files || legacyFiles || {};
    const added = Object.keys(fileHashes).filter((f) => !(f in old));
    const removed = Object.keys(old).filter((f) => !(f in fileHashes));
    const modified = Object.keys(fileHashes).filter((f) => f in old && old[f] !== fileHashes[f]);
    const list = [...modified, ...added].filter((f) => f !== "manifest.json");
    changes = !prev ? "Première publication."
      : !Object.keys(old).length ? (sameBase ? "Fichiers modifiés." : `Lumen ${baseVersion}.`)
      : [
          modified.length ? `${modified.length} fichier(s) modifié(s)` : "",
          added.length ? `${added.length} ajouté(s)` : "",
          removed.length ? `${removed.length} retiré(s)` : "",
        ].filter(Boolean).join(", ") + (list.length ? ` : ${list.slice(0, 6).join(", ")}${list.length > 6 ? "…" : ""}` : "") || "Manifeste modifié.";
  }
  const version = rev ? `${baseVersion}-r${rev}` : baseVersion;
  nextRevs.apps[pkg.id] = { rev, contentHash, files: fileHashes };

  const manifest = manifestOf(pkg, entry, version);
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

  const archive = join(outDir, `${pkg.id}.lumenapp`);
  rmSync(archive, { force: true });
  // `-X` retire les attributs étendus, `-x '._*'` et COPYFILE_DISABLE écartent
  // les doublons AppleDouble. Les trois sont nécessaires : le disque de travail
  // est en exFAT, où macOS écrit les métadonnées de CHAQUE fichier dans un
  // `._nom` voisin — 4 Ko de parasite par fichier, embarqués dans le paquet et
  // servis aux utilisateurs. Ensemble, ils rendent aussi l'archive
  // reproductible : même contenu, même empreinte.
  execFileSync("zip", ["-q", "-r", "-X", archive, ".", "-x", "._*", "-x", "*/._*", "-x", ".DS_Store", "-x", "*/.DS_Store"], {
    cwd: staging,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  rmSync(staging, { recursive: true, force: true });

  const bytes = readFileSync(archive);
  return {
    ...manifest,
    rev, contentHash, updated, changes,
    bumped: !prev || prev.contentHash !== contentHash || !sameBase,
    url: `${baseUrl}${pkg.id}.lumenapp`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    files: files.size,
  };
}

/* ---- Exécution ----------------------------------------------------------- */

mkdirSync(outDir, { recursive: true });
const selected = (only.length ? PACKAGES.filter((p) => only.includes(p.id)) : PACKAGES)
  .filter((p) => !excluded.has(p.id));
if (!selected.length) {
  console.error(`Aucun paquet ne correspond à : ${only.join(", ")}`);
  process.exit(1);
}

const apps = [];
let failed = 0;
for (const pkg of selected) {
  try {
    const entry = build(pkg);
    apps.push(entry);
    const kb = (entry.size / 1024).toFixed(0).padStart(6);
    const mark = entry.bumped ? `  ↑ ${entry.version}  ${entry.changes}` : `    ${entry.version}`;
    console.log(`  ✓ ${pkg.id.padEnd(14)} ${kb} Ko  ${String(entry.files).padStart(4)} fichiers${mark}`);
    delete entry.bumped;
  } catch (err) {
    failed++;
    console.error(`  ✗ ${pkg.id.padEnd(14)} ${err.message}`);
  }
}

// L'index n'est réécrit que si TOUS les paquets demandés ont été produits :
// publier un index partiel ferait disparaître des apps du Catalogue sans que
// personne ne l'ait décidé.
if (!failed && !only.length) {
  const index = { version: 1, generated: new Date().toISOString(), apps };
  writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 2));
  writeFileSync(join(outDir, "revs.json"), JSON.stringify(nextRevs));
  const bumped = apps.filter((a) => a.updated && a.updated >= nextRevs.generated);
  console.log(bumped.length ? `\n${bumped.length} application(s) à mettre à jour : ${bumped.map((a) => `${a.id} ${a.version}`).join(", ")}` : "\nAucun changement de contenu : versions inchangées.");
  console.log(`\nIndex écrit : ${relative(ROOT, join(outDir, "index.json"))} (${apps.length} applications)`);
  console.log("Signez-le avec : node scripts/repo-sign.mjs " + relative(ROOT, join(outDir, "index.json")));
} else if (failed) {
  console.error(`\n${failed} paquet(s) en échec — index non réécrit.`);
  process.exit(1);
}

// Silence le linter sur les imports non utilisés en mode sélectif.
void readdirSync;
