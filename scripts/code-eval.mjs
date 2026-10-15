#!/usr/bin/env node
/**
 * Banc du harnais de code de l'Éditeur (src/editor/code-harness.js).
 *
 *   npm run eval:code
 *
 * Rejoue des scénarios scriptés (le « modèle » est une liste de réponses) pour
 * vérifier le protocole : lecture, édition, création, refus d'un « done » sur
 * du code cassé, JSON illisible, budget, boucle à vide, inlining pour
 * l'exécution. Aucun LLM ni navigateur requis.
 */
import { runCodeHarness, parseTurn, staticCheck, inlineApp } from "../src/editor/code-harness.js";

const J = (o) => JSON.stringify(o);
const scripted = (replies) => {
  let i = 0;
  const seen = [];
  const llm = async (messages) => { seen.push(messages); return replies[Math.min(i++, replies.length - 1)]; };
  return { llm, seen, calls: () => i };
};

const APP = {
  "index.html": '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><button id="go">Go</button><script src="app.js" defer></script></body></html>',
  "styles.css": "button{padding:8px}",
  "app.js": "// logique\n",
};

const cases = [
  ["édition puis done", async () => {
    const m = scripted([
      J({ thought: "ajouter le clic", actions: [{ type: "edit", path: "app.js", search: "// logique", replace: 'document.getElementById("go").onclick = () => alert("Bonjour");' }, { type: "check" }] }),
      J({ actions: [{ type: "done", summary: "Alerte ajoutée." }] }),
    ]);
    const r = await runCodeHarness({ instruction: "alerte", files: APP, llm: m.llm });
    return r.status === "done" && /alert\("Bonjour"\)/.test(r.files["app.js"]) && r.summary === "Alerte ajoutée." && APP["app.js"] === "// logique\n";
  }],
  ["app neuve depuis un dossier vide", async () => {
    const m = scripted([J({ actions: [
      { type: "write", path: "index.html", content: '<html><head><link rel="stylesheet" href="styles.css"></head><body><script src="app.js" defer></script></body></html>' },
      { type: "write", path: "styles.css", content: "body{margin:0}" },
      { type: "write", path: "app.js", content: "let n = 0;" },
      { type: "check" }, { type: "done", summary: "Créée." }] })]);
    const r = await runCodeHarness({ instruction: "crée", files: {}, llm: m.llm });
    return r.status === "done" && Object.keys(r.files).length === 3 && m.calls() === 1;
  }],
  ["done refusé tant que la syntaxe est cassée", async () => {
    const m = scripted([
      J({ actions: [{ type: "write", path: "app.js", content: "function x( {" }, { type: "done", summary: "fini" }] }),
      J({ actions: [{ type: "write", path: "app.js", content: "function x() {}" }, { type: "check" }, { type: "done", summary: "corrigé" }] }),
    ]);
    const r = await runCodeHarness({ instruction: "x", files: APP, llm: m.llm });
    const refusal = m.seen[1].at(-1).content;
    return r.status === "done" && r.summary === "corrigé" && /il reste des problèmes/.test(refusal) && !r.problems.length;
  }],
  ["lien cassé détecté", async () => {
    const p = staticCheck({ "index.html": '<script src="main.js"></script><script src="https://cdn.x/y.js"></script>' });
    return p.length === 2 && p.some((x) => /main\.js/.test(x)) && p.some((x) => /externe/.test(x));
  }],
  ["erreur d'exécution remontée au modèle", async () => {
    const m = scripted([
      J({ actions: [{ type: "check" }] }),
      J({ actions: [{ type: "done", summary: "ok" }] }),
    ]);
    let runs = 0;
    const r = await runCodeHarness({ instruction: "x", files: APP, llm: m.llm, runtimeCheck: async () => (runs++ ? [] : ["exécution : go is not defined"]) });
    return /go is not defined/.test(m.seen[1].at(-1).content) && r.status === "done";
  }],
  ["search introuvable ou ambigu signalé", async () => {
    const m = scripted([
      J({ actions: [{ type: "edit", path: "app.js", search: "absent", replace: "y" }, { type: "edit", path: "styles.css", search: "p", replace: "q" }] }),
      J({ actions: [{ type: "done", summary: "s" }] }),
    ]);
    await runCodeHarness({ instruction: "x", files: { ...APP, "styles.css": "p{} p{}" }, llm: m.llm });
    const obs = m.seen[1].at(-1).content;
    return /introuvable/.test(obs) && /plusieurs fois/.test(obs);
  }],
  ["JSON illisible : relance puis arrêt", async () => {
    const m = scripted(["Voici le code : ...", "toujours pas", "non"]);
    const r = await runCodeHarness({ instruction: "x", files: APP, llm: m.llm });
    return r.status === "stalled" && m.calls() === 3;
  }],
  ["budget respecté", async () => {
    const m = scripted([J({ actions: [{ type: "read", path: "app.js" }] })]);
    const r = await runCodeHarness({ instruction: "x", files: APP, llm: m.llm, maxSteps: 4 });
    return r.status === "budget" && m.calls() === 4 && /plus que/.test(m.seen[3].at(-1).content);
  }],
  ["boucle à vide stoppée", async () => {
    const m = scripted([J({ actions: [{ type: "edit", path: "nope.js", search: "a", replace: "b" }] })]);
    const r = await runCodeHarness({ instruction: "x", files: APP, llm: m.llm, maxSteps: 10 });
    return r.status === "stalled" && m.calls() === 3;
  }],
  ["ancien format {files:[…]} et balises ``` tolérés", async () => {
    const t = parseTurn("```json\n" + J({ summary: "s", files: [{ path: "a.js", content: "1" }, { path: "b.js", hunks: [{ search: "x", replace: "y" }] }] }) + "\n```");
    return t && t.actions.map((a) => a.type).join(",") === "write,edit,done";
  }],
  ["<think> retiré avant parsing", async () => {
    const t = parseTurn("<think>{faux}</think>" + J({ actions: [{ type: "list" }] }));
    return t && t.actions[0].type === "list";
  }],
  ["contexte compacté sur une longue session", async () => {
    const m = scripted([J({ actions: [{ type: "read", path: "app.js" }, { type: "list" }] })]);
    await runCodeHarness({ instruction: "x", files: APP, llm: m.llm, maxSteps: 20 });
    const last = m.seen.at(-1);
    return last.length <= 15 && last[0].role === "system" && /DEMANDE/.test(last[1].content);
  }],
  ["inlining : CSS, script defer en fin de body", async () => {
    const html = inlineApp({ ...APP, "app.js": "var a=1;</script>" });
    return /<style>[\s\S]*padding/.test(html) && /<button[\s\S]*<script>[\s\S]*var a=1;<\\\/script>[\s\S]*<\/body>/.test(html) && !/src="app\.js"/.test(html);
  }],
  ["schéma : aucune demande ne force un json_schema", async () => {
    const m = scripted([J({ actions: [{ type: "done", summary: "s" }] })]);
    await runCodeHarness({ instruction: "x", files: APP, llm: m.llm });
    return !m.seen[0].schema && /"actions"/.test(m.seen[0][0].content);
  }],
];

let ok = 0;
for (const [name, fn] of cases) {
  let pass = false, err = "";
  try { pass = await fn(); } catch (e) { err = e.stack || String(e); }
  console.log(`${pass ? "✓" : "✗"} ${name}${err ? "\n  " + err : ""}`);
  if (pass) ok++;
}
console.log(`\n${ok}/${cases.length} scénarios réussis.`);
process.exit(ok === cases.length ? 0 : 1);
