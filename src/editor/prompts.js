// Prompts IA de l'Éditeur de code (lus aussi par le banc `npm run bench`).
import { buildPrompt } from "../lib/prompt-kit.js";

const SNIPPET = "function total(items) {\n  let t = 0;\n  for (const i of items) t += i.price * i.qty;\n  return t;\n}";

export const PROMPTS = {
  "app.editor.chat": {
    kind: "explain",
    label: "Éditeur — question sur le code",
    role: "Tu aides à comprendre et améliorer du code. Ne renvoie pas tout le fichier.",
    build: ({ request, code, language = "javascript", lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.editor.chat", kind: "explain", lang, role: PROMPTS["app.editor.chat"].role, data: { [`EXTRAIT (${language})`]: code }, request, format: "une réponse claire et brève ; du code seulement pour les lignes concernées." }),
    }),
    bench: [{ vars: { request: "Comment gérer un tableau vide ou undefined ?", code: SNIPPET }, expect: { re: ["undefined|vide|\\?\\?|\\|\\||Array\\.isArray|!items"], lang: "fr" } }],
  },
  "app.editor.modify": {
    kind: "code",
    label: "Éditeur — modifier la sélection",
    role: "Tu modifies un extrait de code selon une instruction, en conservant l'indentation et le style.",
    build: ({ instruction, code, language = "javascript" }) => ({
      messages: buildPrompt({ id: "app.editor.modify", kind: "code", lang: "", role: PROMPTS["app.editor.modify"].role, data: { [`CODE (${language})`]: code }, request: instruction, format: "le code modifié seul, sans explication ni balises ```." }),
    }),
    bench: [{ vars: { instruction: "utilise reduce au lieu de la boucle", code: SNIPPET }, expect: { re: ["reduce", "price", "qty"], not: ["^```", "^voici"] } }],
  },
  "app.editor.explain": {
    kind: "explain",
    label: "Éditeur — expliquer la sélection",
    role: "Tu expliques ce que fait un extrait de code.",
    build: ({ code, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.editor.explain", kind: "explain", lang, role: PROMPTS["app.editor.explain"].role, data: { CODE: code }, format: "3 à 5 phrases." }),
    }),
    bench: [{ vars: { code: SNIPPET }, expect: { re: ["total|somme|prix"], lang: "fr", maxChars: 1200 } }],
  },
  "app.editor.folder": {
    kind: "agent",
    label: "Éditeur — IA sur un dossier (multi-fichiers)",
    role: `Tu es un agent de code qui modifie une app web multi-fichiers (HTML, CSS, JS) dans un dossier. Tu peux modifier et créer des fichiers en gardant l'app cohérente (index.html lie ses styles.css et app.js). Aucune dépendance externe ni CDN ; chemins relatifs au dossier.
Pour MODIFIER un fichier, préfère des éditions ciblées : action "edit" + "hunks": [{"search":"texte EXACT et UNIQUE du fichier","replace":"remplacement"}]. Action "create" ou "rewrite" + "content" : le fichier entier (création ou refonte).
N'inclus que les fichiers réellement modifiés ou créés.`,
    build: ({ instruction, files, agentic = false, iter = 1, maxIters = 1 }) => ({
      messages: buildPrompt({ id: "app.editor.folder", kind: "agent", lang: "", role: PROMPTS["app.editor.folder"].role,
        data: { MODE: agentic ? `agent borné, itération ${iter}/${maxIters} : analyse, planifie, modifie puis stabilise sans dépasser le budget.` : "modification unique, validée par l'utilisateur sur un diff.",
          "FICHIERS DU DOSSIER": Object.entries(files).map(([p, c]) => `===== ${p} =====\n${c}`).join("\n\n") },
        request: instruction,
        format: "action edit avec hunks search/replace (search = texte EXACT et UNIQUE du fichier), ou create/rewrite avec content.", example: { summary: "Le titre affiche désormais la date.", files: [{ path: "app.js", action: "edit", hunks: [{ search: "title.textContent = \"Accueil\";", replace: "title.textContent = `Accueil — ${new Date().toLocaleDateString()}`;" }] }] } }),
      opts: { json: true },
    }),
    bench: [{ vars: { instruction: "Le bouton doit afficher « Bonjour » dans une alerte au clic.", files: { "index.html": "<!doctype html><html><head><link rel=\"stylesheet\" href=\"styles.css\"></head><body><button id=\"go\">Go</button><script src=\"app.js\" defer></script></body></html>", "app.js": "// logique\n" } },
      expect: { json: true, keys: ["files"], jsonCheck: { "modifie app.js": (j) => (j.files || []).some((f) => /app\.js$/.test(f.path || "")), "ajoute l'alerte": (j) => /alert/.test(JSON.stringify(j.files || [])) } } }],
  },
};
