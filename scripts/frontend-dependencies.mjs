// Dependency graph shared by catalogue packaging and the core release builder.
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
/**
 * Dossiers copiés intégralement dès qu'un paquet en touche un fichier : leurs
 * contenus sont chargés par des chemins construits à l'exécution, invisibles
 * pour l'analyse statique.
 */
const ASSET_DIRS = ["icons", "lib/brand", "lib/loaders", "lib/avatars/metrocity", "lib/vendor/pdfjs", "lib/vendor/katex", "lib/vendor/maplibre"];

/**
 * Sous-dossiers d'assets d'une app, copiés en entier dès que l'app est dans le
 * paquet. Le Village en est l'exemple : ses sprites sont chargés par des chemins
 * assemblés à l'exécution depuis un manifeste, donc jamais visibles ici. Sans
 * cette règle, le paquet se construit sans erreur et l'app s'ouvre vide.
 */
const APP_ASSET_SUBDIRS = ["assets", "sprites", "packs", "models", "sounds", "vendor", "samples"];

// Références statiques : `from "…"`, `import("…")`, src=, href=, url(…).
const REF_PATTERNS = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\b(?:src|href)\s*=\s*["']([^"']+)["']/g,
  /\burl\(\s*["']?([^"')]+)["']?\s*\)/g,
  // Workers : `new Worker(new URL("./x.js", import.meta.url))` ou `new Worker("./x.js")`.
  /\bnew\s+Worker\s*\(\s*(?:new\s+URL\s*\(\s*)?["']([^"']+)["']/g,
  // Fichiers résolus à l'exécution : `new URL("./stream-view.css", import.meta.url)`.
  // Sans ce motif, la feuille de style des blocs « réflexion » manquait dans
  // les paquets : icône de chargement géante, sans mise en forme (app PDF…).
  /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g,
];

const isExternal = (ref) => /^(https?:|data:|blob:|#|mailto:|\/\/|ipc:|lumenapp:)/i.test(ref);

/** Chemin relatif à `src/`, ou `null` si la référence sort du projet. */
function resolveRef(SRC, fromRel, ref) {
  if (!ref || isExternal(ref)) return null;
  const clean = ref.split(/[?#]/)[0];
  if (!clean) return null;
  // Une référence absolue est relative à la racine servie, c'est-à-dire `src/`.
  const rel = clean.startsWith("/")
    ? clean.slice(1)
    : posix.normalize(posix.join(posix.dirname(fromRel), clean));
  if (rel.startsWith("..")) return null;
  if (/(^|\/)\._/.test(rel)) return null;
  return existsSync(join(SRC, rel)) && statSync(join(SRC, rel)).isFile() ? rel : null;
}

export function collectDependencies(SRC, entries, { includeAppAssets = true, follow = () => true } = {}) {
  const seen = new Set();
  const assetDirs = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);

    for (const dir of ASSET_DIRS) {
      if (rel.startsWith(`${dir}/`)) assetDirs.add(dir);
    }
    // Avatars des agents (lib/avatars) : leurs feuilles de sprites sont
    // chargées par chemin calculé — on les joint dès que le module entre.
    if (rel === "lib/avatars/metrocity.js") assetDirs.add("lib/avatars/metrocity");
    // Personnages Kenney des agents : images résolues par `import.meta.url`.
    if (rel === "lib/agent-avatar.js") assetDirs.add("lib/avatars/kenney");
    // Dès qu'un fichier d'une app entre dans le paquet, ses dossiers d'assets
    // y entrent aussi — en entier, sans chercher à savoir lesquels servent.
    const appDir = rel.split("/")[0];
    // `lib/` n'est pas une app : son `vendor/` (pdf.js, ExcelJS, KaTeX…) est
    // suivi fichier par fichier, sinon chaque paquet embarquerait 5 Mo inutiles.
    for (const sub of appDir === "lib" || !includeAppAssets ? [] : APP_ASSET_SUBDIRS) {
      const candidate = `${appDir}/${sub}`;
      if (existsSync(join(SRC, candidate)) && statSync(join(SRC, candidate)).isDirectory()) {
        assetDirs.add(candidate);
      }
    }
    if (!/\.(html?|m?js|css)$/i.test(rel)) continue;

    const text = readFileSync(join(SRC, rel), "utf8");
    for (const pattern of REF_PATTERNS) {
      for (const [, ref] of text.matchAll(pattern)) {
        const next = resolveRef(SRC, rel, ref);
        if (next && follow(next)) queue.push(next);
      }
    }
  }
  return { files: seen, assetDirs };
}

