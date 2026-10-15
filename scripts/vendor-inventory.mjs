// Inventaire des bibliothèques npm RÉELLEMENT livrées au navigateur.
//
// PDF.js, KaTeX, MapLibre, pdf-lib, fflate, ExcelJS… sont des
// devDependencies (outils de build) mais scripts/build-vendor.mjs les copie ou
// les empaquette dans src/lib/vendor/ : elles partent avec l'app. Un
// `npm audit --omit=dev` passait donc à côté. Ce script :
//   1. relève les paquets lus par build-vendor.mjs (chemins node_modules et
//      imports des points d'entrée esbuild) ;
//   2. ajoute leurs dépendances transitives (`npm ls --all`) ;
//   3. note la version installée de chacun ;
//   4. croise avec le rapport `npm audit` complet (dist/security/npm-audit.json).
// Sortie : dist/security/vendored.json ; code 1 si un paquet livré est signalé.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist/security");
mkdirSync(OUT, { recursive: true });

const pkgName = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2) : spec.split("/").slice(0, 1)).join("/");
const src = readFileSync(join(ROOT, "scripts/build-vendor.mjs"), "utf8");
const roots = new Set([
  ...[...src.matchAll(/join\(NM,\s*"([^"]+)"/g)].map((m) => pkgName(m[1])),
  ...[...src.matchAll(/from \\?"([^".][^"\\]*)\\?"/g)].map((m) => pkgName(m[1])).filter((n) => !/^(node:|esbuild$)/.test(n)),
]);

function fullTree() {
  const opts = { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 };
  try {
    return JSON.parse(execFileSync("npm", ["ls", "--all", "--json"], opts));
  } catch (e) {
    // `npm ls` sort en erreur au moindre paquet superflu, mais l'arbre est là.
    try { return JSON.parse(e.stdout || "{}"); } catch { return {}; }
  }
}
const shipped = new Map(); // nom → Set(versions)
function walk(deps, via) {
  for (const [name, info] of Object.entries(deps || {})) {
    if (!shipped.has(name)) shipped.set(name, { versions: new Set(), via: new Set() });
    if (info.version) shipped.get(name).versions.add(info.version);
    shipped.get(name).via.add(via);
    walk(info.dependencies, via);
  }
}
const top = fullTree().dependencies || {};
for (const root of roots) walk(top[root] ? { [root]: top[root] } : {}, root);

const auditFile = join(OUT, "npm-audit.json");
const vulns = existsSync(auditFile) ? JSON.parse(readFileSync(auditFile, "utf8")).vulnerabilities || {} : null;
const report = [...shipped].sort(([a], [b]) => a.localeCompare(b)).map(([name, s]) => ({
  name, versions: [...s.versions], shippedVia: [...s.via],
  ...(vulns?.[name] ? { advisory: { severity: vulns[name].severity, range: vulns[name].range } } : {}),
}));
writeFileSync(join(OUT, "vendored.json"), JSON.stringify({ roots: [...roots], packages: report }, null, 2));

console.log(`Paquets livrés au navigateur : ${roots.size} racines, ${report.length} paquets au total`);
for (const r of report.filter((p) => roots.has(p.name))) console.log(`  - ${r.name}@${r.versions.join(", ")}`);
if (!vulns) { console.log("(pas de rapport npm audit : croisement ignoré)"); process.exit(0); }
// Avis examinés et jugés inatteignables dans le bundle livré (voir
// docs/security-risk-register.md). Appariés sur la plage exacte : un nouvel avis
// sur le même paquet fait de nouveau échouer le script.
const ACCEPTED = {
  // R-009 : exceljs n'appelle que uuid.v4() sans tampon ; l'avis vise v3/v5/v6(buf).
  uuid: { range: "<11.1.1", ref: "R-009" },
  exceljs: { range: ">=3.5.0", ref: "R-009" }, // signalé uniquement via uuid
};
for (const p of report) {
  const a = p.advisory && ACCEPTED[p.name];
  if (a && a.range === p.advisory.range) { p.advisory.accepted = a.ref; console.log(`  ✓ ${p.name}@${p.versions.join(", ")} — ${p.advisory.severity} (${p.advisory.range}) accepté, ${a.ref}`); }
}
writeFileSync(join(OUT, "vendored.json"), JSON.stringify({ roots: [...roots], packages: report }, null, 2));
const flagged = report.filter((p) => p.advisory && !p.advisory.accepted);
for (const f of flagged) console.log(`  ⚠ ${f.name}@${f.versions.join(", ")} — ${f.advisory.severity} (${f.advisory.range}) via ${f.shippedVia.join(", ")}`);
console.log(flagged.length ? `${flagged.length} paquet(s) livré(s) signalé(s) par npm audit.` : "Aucun paquet livré signalé par npm audit.");
process.exit(flagged.length ? 1 : 0);
