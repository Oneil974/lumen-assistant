#!/usr/bin/env node
/**
 * Fabrique les bibliothèques tierces embarquées dans `src/lib/vendor/`.
 *
 *   node scripts/build-vendor.mjs      (npm run vendor:build)
 *
 * Lumen n'a pas d'étape de build pour son front : chaque page charge des
 * modules ES servis tels quels. Les bibliothèques npm sont donc converties UNE
 * FOIS en modules ES autonomes (esbuild), et le résultat est versionné — le
 * poste de l'utilisateur, hors ligne, n'a jamais besoin de npm.
 *
 * Toutes sont chargées à la demande (`import()`), jamais au démarrage d'une page.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NM = join(ROOT, "node_modules");
const OUT = join(ROOT, "src/lib/vendor");
const TMP = join(ROOT, "node_modules/.vendor-entries");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

async function bundle(name, source) {
  const entry = join(TMP, `${name.replace(/\//g, "_")}.mjs`);
  writeFileSync(entry, source);
  await build({
    entryPoints: [entry], outfile: join(OUT, `${name}.js`), bundle: true, format: "esm",
    minify: true, platform: "browser", target: "safari15", legalComments: "linked",
    define: { global: "globalThis" }, logLevel: "warning",
  });
  console.log(`  ✓ ${name}.js`);
}

// pdf.js : déjà distribué en modules ES (lecteur + worker séparés).
mkdirSync(join(OUT, "pdfjs"), { recursive: true });
cpSync(join(NM, "pdfjs-dist/build/pdf.min.mjs"), join(OUT, "pdfjs/pdf.min.js"));
cpSync(join(NM, "pdfjs-dist/build/pdf.worker.min.mjs"), join(OUT, "pdfjs/pdf.worker.min.js"));
cpSync(join(NM, "pdfjs-dist/LICENSE"), join(OUT, "pdfjs/LICENSE"));
console.log("  ✓ pdfjs/");

// KaTeX : module + feuille de style + polices (chemins relatifs à la CSS).
mkdirSync(join(OUT, "katex"), { recursive: true });
cpSync(join(NM, "katex/dist/katex.min.css"), join(OUT, "katex/katex.min.css"));
cpSync(join(NM, "katex/dist/fonts"), join(OUT, "katex/fonts"), { recursive: true });
cpSync(join(NM, "katex/LICENSE"), join(OUT, "katex/LICENSE"));
await bundle("katex/katex", `export { default } from "katex";`);

// MapLibre GL : depuis la v6, le paquet n'est plus livré qu'en modules ES
// (principal + worker + chunk partagé, reliés par import.meta.url). On le
// ré-empaquette en deux fichiers autonomes : un IIFE qui garnit
// window.maplibregl (chargé par <script>, comme l'ancien UMD) et un worker ES
// dont l'URL est calculée à partir de celle du script — fonctionne tel quel
// dans l'app et dans un paquet .lumenapp.
mkdirSync(join(OUT, "maplibre"), { recursive: true });
{
  const common = { bundle: true, minify: true, platform: "browser", target: "safari15", legalComments: "linked", logLevel: "warning" };
  const entry = join(TMP, "maplibre.mjs");
  writeFileSync(entry, `import * as m from "maplibre-gl";
const src = document.currentScript && document.currentScript.src;
if (src) m.setWorkerUrl(new URL("maplibre-gl-worker.js", src).href);
window.maplibregl = m;`);
  await build({ ...common, entryPoints: [entry], outfile: join(OUT, "maplibre/maplibre-gl.js"), format: "iife" });
  await build({ ...common, entryPoints: [join(NM, "maplibre-gl/dist/maplibre-gl-worker.mjs")], outfile: join(OUT, "maplibre/maplibre-gl-worker.js"), format: "esm" });
}
cpSync(join(NM, "maplibre-gl/dist/maplibre-gl.css"), join(OUT, "maplibre/maplibre-gl.css"));
cpSync(join(NM, "maplibre-gl/LICENSE.txt"), join(OUT, "maplibre/LICENSE.txt"));
console.log("  ✓ maplibre/");

await bundle("pdf-lib", `export * from "pdf-lib";`);
await bundle("fflate", `export * from "fflate";`);
await bundle("exceljs", `import ExcelJS from "exceljs/dist/exceljs.min.js"; export default ExcelJS;`);

rmSync(TMP, { recursive: true, force: true });
await import('./collect-npm-licenses.mjs');
console.log("Bibliothèques prêtes dans src/lib/vendor/");
