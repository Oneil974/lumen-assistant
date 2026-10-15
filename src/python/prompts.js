// Prompts IA de l'app Python (Pyodide). Lus aussi par le banc `npm run bench`.
import { buildPrompt } from "../lib/prompt-kit.js";

const ENV = "Ton code est exécuté par Pyodide (Python 3 en WebAssembly, sans réseau ni processus). Bibliothèques : bibliothèque standard, numpy, pandas, matplotlib (backend AGG : plt.figure()/plt.plot(), jamais plt.show()), scipy, scikit-learn, sympy, pillow. Les fichiers du projet sont dans le répertoire courant.";
const CODE_ONLY = "le code Python seul, sans explication ni balises ```.";

export const PROMPTS = {
  "app.python.write": {
    kind: "code",
    label: "Python — écrire ou compléter le script",
    role: `Tu écris du Python 3. ${ENV}`,
    build: ({ request, script = "" }) => ({
      messages: buildPrompt({ id: "app.python.write", kind: "code", lang: "", role: PROMPTS["app.python.write"].role,
        data: { "SCRIPT ACTUEL": script }, request: script ? `${request}\nRenvoie le script complet mis à jour.` : request, format: CODE_ONLY }),
    }),
    bench: [{ vars: { request: "Calcule la moyenne des nombres 4, 8 et 15 et affiche-la." }, expect: { re: ["print\\(", "4", "15"], not: ["^```", "plt\\.show"] } }],
  },
  "app.python.modify": {
    kind: "code",
    label: "Python — modifier la sélection",
    role: `Tu modifies un extrait de script Python en conservant l'indentation et le style. ${ENV}`,
    build: ({ instruction, code }) => ({
      messages: buildPrompt({ id: "app.python.modify", kind: "code", lang: "", role: PROMPTS["app.python.modify"].role, data: { CODE: code }, request: instruction, format: CODE_ONLY }),
    }),
    bench: [{ vars: { instruction: "arrondis le résultat à 2 décimales", code: "m = sum(xs) / len(xs)\nprint(m)" }, expect: { re: ["round\\(|:\\.2f|%\\.2f"], not: ["^```"] } }],
  },
  "app.python.fix": {
    kind: "code",
    label: "Python — corriger une erreur",
    role: `Tu corriges un script Python pour que l'erreur disparaisse, sans changer ce qu'il doit faire. ${ENV}`,
    build: ({ script, error }) => ({
      messages: buildPrompt({ id: "app.python.fix", kind: "code", lang: "", role: PROMPTS["app.python.fix"].role, data: { SCRIPT: script, ERREUR: error }, format: `le script complet corrigé : ${CODE_ONLY}` }),
    }),
    bench: [{ vars: { script: "import pandas as pd\ndf = pd.DataFrame({'a': [1, 2]})\nprint(df['b'].sum())", error: "KeyError: 'b'" }, expect: { re: ["df\\[['\"]a['\"]\\]|'b' in|\"b\" in|get\\("], not: ["^```"] } }],
  },
  "app.python.explain": {
    kind: "explain",
    label: "Python — expliquer la sélection",
    role: "Tu expliques ce que fait un extrait de code Python.",
    build: ({ code, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.python.explain", kind: "explain", lang, role: PROMPTS["app.python.explain"].role, data: { CODE: code }, format: "3 à 5 phrases." }),
    }),
    bench: [{ vars: { code: "def f(xs):\n    return sorted(set(xs), reverse=True)[:3]" }, expect: { re: ["trois|3", "doublon|uniq|set|distinct"], lang: "fr", maxChars: 1200 } }],
  },
};
