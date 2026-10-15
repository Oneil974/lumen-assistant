// Prompts IA de l'app Fichiers (sandbox), de l'éditeur créatif (documents et
// présentations) et d'App Studio. Lus aussi par le banc `npm run bench`.
import { buildPrompt } from "../lib/prompt-kit.js";

const ASCII_RULE = "Noms techniques (fichiers, ids, classes, fonctions, variables, sélecteurs) en ASCII uniquement ; tirets « - » (U+002D), jamais « – » ni « — ».";
const docs = (list) => list.map((d) => `===== ${d.path} =====\n${d.content}${d.truncated ? "\n… (tronqué)" : ""}`).join("\n\n");
const NOTE = "# Courses\n- pain\n- lait\n\n# Rendez-vous\nGarage mardi 9h";

export const PROMPTS = {
  "app.files.selection": {
    kind: "transform",
    label: "Fichiers — IA sur la sélection",
    role: "Tu appliques une consigne à un extrait de fichier.",
    build: ({ instruction, text }) => ({
      messages: buildPrompt({ id: "app.files.selection", kind: "transform", lang: "", role: PROMPTS["app.files.selection"].role, data: { EXTRAIT: text }, request: instruction, format: "l'extrait transformé seul." }),
    }),
    bench: [{ vars: { instruction: "Mets en majuscules les titres", text: "# courses\n- pain" }, expect: { re: ["# COURSES", "pain"], not: ["^voici", "^\"\"\""] } }],
  },
  "app.files.ask": {
    kind: "grounded",
    label: "Fichiers — question sur le fichier",
    role: "Tu réponds à une question sur un fichier de l'utilisateur, d'après son contenu.",
    build: ({ request, path, content, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.files.ask", kind: "grounded", lang, role: PROMPTS["app.files.ask"].role, data: { [`FICHIER « ${path} »`]: content }, request }),
    }),
    bench: [{ vars: { request: "Quand est mon rendez-vous au garage ?", path: "notes.md", content: NOTE }, expect: { re: ["mardi", "9"] } }],
  },
  "app.files.edit": {
    kind: "transform",
    label: "Fichiers — modifier le fichier",
    role: "Tu modifies un fichier selon la demande de l'utilisateur, sans toucher au reste.",
    build: ({ request, path, content }) => ({
      messages: buildPrompt({ id: "app.files.edit", kind: "transform", lang: "", role: PROMPTS["app.files.edit"].role, data: { [`FICHIER « ${path} »`]: content }, request, format: "le contenu COMPLET du fichier modifié, sans bloc ```." }),
    }),
    bench: [{ vars: { request: "ajoute « œufs » à la liste de courses", path: "notes.md", content: NOTE }, expect: { re: ["œufs|oeufs", "pain", "Garage mardi 9h"], not: ["^```"] } }],
  },
  "app.files.multi-ask": {
    kind: "grounded",
    label: "Fichiers — question sur plusieurs fichiers",
    role: "Tu analyses plusieurs fichiers d'une sandbox pour répondre à une demande, en citant le fichier d'où vient chaque information.",
    build: ({ request, files, lang = "fr" }) => ({
      messages: buildPrompt({ id: "app.files.multi-ask", kind: "grounded", lang, role: PROMPTS["app.files.multi-ask"].role, data: { FICHIERS: docs(files) }, request }),
    }),
    bench: [{ vars: { request: "Quel fichier parle du budget et quel est son montant ?", files: [{ path: "a.md", content: "Réunion : budget 12 000 €." }, { path: "b.md", content: "Liste de courses." }] }, expect: { re: ["a\\.md", "12 ?000"] } }],
  },
  "app.files.multi-edit": {
    kind: "agent",
    label: "Fichiers — modifier plusieurs fichiers",
    role: "Tu es un agent de code dans Lumen : tu modifies uniquement les fichiers fournis, sans en créer d'autres et en gardant leurs chemins exacts. Pour chaque fichier modifié, renvoie son contenu complet, pas un extrait.",
    build: ({ request, files, agentic = false, iter = 1, maxIterations = 1 }) => ({
      messages: buildPrompt({ id: "app.files.multi-edit", kind: "agent", lang: "", role: PROMPTS["app.files.multi-edit"].role,
        data: { MODE: agentic ? `agent borné, itération ${iter}/${maxIterations} : analyse, corrige, puis stabilise.` : "modification unique, validée sur un diff.", FICHIERS: docs(files) },
        request, format: "contenu COMPLET de chaque fichier modifié ; files vide si rien n'est à faire.", example: { summary: "Titre corrigé dans readme.md", files: [{ path: "readme.md", content: "# Mon projet\nVersion 2" }] } }),
      opts: { json: true },
    }),
    bench: [{ vars: { request: "Remplace « Bonjour » par « Salut » partout", files: [{ path: "a.txt", content: "Bonjour Paul" }, { path: "b.txt", content: "Au revoir" }] },
      expect: { json: true, keys: ["files"], jsonCheck: { "a.txt modifié": (j) => (j.files || []).some((f) => f.path === "a.txt" && /Salut Paul/.test(f.content || "")), "b.txt intact": (j) => !(j.files || []).some((f) => f.path === "b.txt" && f.content !== "Au revoir") } } }],
  },
  "app.creative.element": {
    kind: "json",
    label: "Éditeur créatif — modifier un élément",
    role: "Tu modifies UN élément d'une page ou d'une diapositive : tu renvoies seulement les champs à changer.",
    build: ({ element, fields, request, memory = "", kind = "document" }) => ({
      messages: buildPrompt({ id: "app.creative.element", kind: "json", lang: "", role: PROMPTS["app.creative.element"].role,
        data: { "SOUVENIRS UTILES": memory, SUPPORT: kind === "presentation" ? "diapositive" : "page", "CHAMPS MODIFIABLES": fields, "ÉLÉMENT ACTUEL (JSON)": typeof element === "string" ? element : JSON.stringify(element) },
        request, format: "seulement les champs à changer, avec des valeurs concrètes.", example: { color: "#1D4ED8", weight: 700 } }),
      opts: { json: true },
    }),
    bench: [{ vars: { element: { type: "text", html: "Titre", color: "#000000", fontSize: 24 }, fields: "html, color (hex), fontSize (nombre), weight (300-800), align", request: "passe le titre en rouge et plus gros" },
      expect: { json: true, jsonCheck: { "couleur rouge": (j) => /^#(f|e|d|c)[0-9a-f]{1}[0-3][0-9a-f][0-3][0-9a-f]$/i.test(j.color || ""), "plus gros": (j) => Number(j.fontSize) > 24 } } }],
  },
  "app.creative.page": {
    kind: "json",
    label: "Éditeur créatif — concevoir la page",
    role: "Tu es directeur artistique : tu conçois le contenu d'une page ou d'une diapositive en éléments positionnés. Chaque texte précise une couleur qui contraste fortement avec le fond.",
    build: ({ request, kind = "document", background = "#ffffff", dark = false, memory = "" }) => ({
      messages: buildPrompt({ id: "app.creative.page", kind: "json", lang: "", role: PROMPTS["app.creative.page"].role,
        data: { "SOUVENIRS UTILES": memory, SUPPORT: kind === "presentation" ? "diapositive 1280×720 px" : "page A4 794×1123 px", FOND: `${background} (${dark ? "sombre : texte clair, ex. #ffffff" : "clair : texte foncé, ex. #1d1d1f"})` },
        request,
        format: "un TABLEAU d'éléments ; x, y, w, h en pixels dans la page ; chaque texte a une couleur contrastée.", example: [{ type: "shape", shape: "rect", x: 0, y: 0, w: 1280, h: 720, fill: "#0F172A" }, { type: "text", html: "Rapport annuel", x: 120, y: 260, w: 1040, h: 120, fontSize: 72, weight: 800, color: "#FFFFFF", align: "center", lineHeight: 1.1 }] }),
      opts: { json: true },
    }),
    bench: [{ vars: { request: "Diapositive de titre « Bilan 2026 » avec un sous-titre", kind: "presentation", background: "#101828", dark: true },
      expect: { json: true, jsonCheck: { "tableau d'éléments": (j) => Array.isArray(j) || Array.isArray(j?.elements), "titre présent": (j) => /Bilan 2026/.test(JSON.stringify(j)), "texte clair sur fond sombre": (j) => /#f{3,6}|#e[0-9a-f]{5}|white/i.test(JSON.stringify(j)) } } }],
  },
  "app.appstudio.single": {
    kind: "code",
    label: "App Studio — mini-app en un fichier",
    role: `Tu es App Studio IA dans Lumen : tu génères une mini-app autonome en UN fichier HTML (CSS et JavaScript inline), sobre, lisible et responsive, qui fonctionne dans une sandbox locale : aucun appel réseau, aucun CDN. ${ASCII_RULE}`,
    build: ({ request }) => ({
      messages: buildPrompt({ id: "app.appstudio.single", kind: "code", lang: "", role: PROMPTS["app.appstudio.single"].role, request, format: "le code HTML complet seul, de <!doctype html> à </html>, sans Markdown." }),
    }),
    bench: [{ vars: { request: "Un compteur avec un bouton + et un bouton −" }, expect: { re: ["<!doctype html|<html", "<button", "<script", "</html>"], not: ["^```", "https?://(cdn|unpkg)"] } }],
  },
  "app.appstudio.agent": {
    kind: "agent",
    label: "App Studio — agent multi-fichiers",
    role: `Tu es App Studio Agent dans Lumen : un agent de code autonome qui construit une mini-app web en trois fichiers. index.html (structure) lie <link rel="stylesheet" href="styles.css"> dans <head> et <script src="app.js" defer></script> ; styles.css porte tout le style ; app.js toute la logique. Aucune dépendance externe, aucun CDN, aucun appel réseau ; chemins relatifs simples, jamais de sous-dossier. ${ASCII_RULE}
Tu travailles par itérations : tu planifies, tu modifies, puis tu relis ton code pour corriger bugs et UX. Pour MODIFIER un fichier existant, préfère des éditions ciblées : action "edit" + "hunks": [{"search":"texte EXACT et UNIQUE du fichier","replace":"nouveau texte"}]. Action "create" ou "rewrite" + "content" : le fichier entier. N'inclus que les fichiers modifiés à ce tour.`,
    build: ({ goal, files = {}, isFirst = true }) => ({
      messages: buildPrompt({ id: "app.appstudio.agent", kind: "agent", lang: "", role: PROMPTS["app.appstudio.agent"].role,
        data: { OBJECTIF: goal, "FICHIERS ACTUELS": isFirst ? "" : Object.entries(files).map(([p, c]) => `===== ${p} =====\n${c}`).join("\n\n") },
        request: isFirst
          ? "Crée l'app depuis zéro : renvoie index.html, styles.css et app.js, chacun en entier (action \"create\")."
          : "Teste mentalement l'app, corrige les bugs et complète l'UX manquante, de préférence par éditions ciblées. Mets \"done\": true quand l'app est complète, correcte et soignée.",
        format: "action : create (fichier entier dans content), rewrite (fichier entier) ou edit (hunks search/replace) ; done à true quand l'app est complète.", example: { plan: "Créer la structure, le style et la logique du minuteur.", files: [{ path: "index.html", action: "create", content: "<!doctype html>\n<html><head><link rel=\"stylesheet\" href=\"styles.css\"></head><body><div id=\"time\">25:00</div><button id=\"start\">Démarrer</button><script src=\"app.js\" defer></script></body></html>" }, { path: "styles.css", action: "create", content: "body { font-family: system-ui; text-align: center; }" }, { path: "app.js", action: "create", content: "document.getElementById(\"start\").addEventListener(\"click\", () => { /* … */ });" }], done: false, summary: "Première version du minuteur." } }),
      opts: { json: true },
    }),
    bench: [{ vars: { goal: "Une liste de tâches : champ texte, bouton Ajouter, cases à cocher." },
      expect: { json: true, keys: ["files"], jsonCheck: { "3 fichiers créés": (j) => ["index.html", "styles.css", "app.js"].every((p) => (j.files || []).some((f) => f.path === p && (f.content || "").length > 20)), "index lie app.js": (j) => /app\.js/.test((j.files || []).find((f) => f.path === "index.html")?.content || "") } } }],
  },
};
