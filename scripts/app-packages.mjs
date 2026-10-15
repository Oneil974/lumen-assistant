/**
 * Ce que Lumen 0.2 sort de son noyau.
 *
 * Le NOYAU — ce qui reste dans le binaire, parce que le reste s'y adosse — est
 * volontairement court : assistant, fichiers/sandbox, équipage (agents, fil,
 * traces, profiler), Fluxo, mémoire, visite guidée, raccourcis, stockage,
 * paramètres, catalogue, documentation. Toutes les autres applications
 * deviennent des paquets téléchargeables, et désinstallables.
 *
 * Chaque entrée ci-dessous produit un `.lumenapp`. Les hubs (Muse, Tempo,
 * Prisme…) ont été DÉFAITS : chaque ancien onglet est une app à part entière,
 * avec sa fenêtre — on en ouvre plusieurs côte à côte, et on les maintient une
 * par une. Le packager sait toujours construire un hub (`tabs`) si un paquet
 * tiers en a besoin.
 *
 * `trust` dit la vérité sur ce qu'une app peut faire :
 *   - `first-party` : signée par Lumen, gardée avec l'accès direct aux commandes
 *     système qu'elle avait déjà quand elle vivait dans le bundle ;
 *   - `third-party` : confinée derrière l'AppKit, capacité par capacité.
 * Aucun paquet du catalogue officiel n'est déclaré first-party « pour aller plus
 * vite » : ils le sont parce que ce sont littéralement les mêmes fichiers.
 */

/** Racine du dépôt, relative à ce fichier. */
export const SRC = "src";

/**
 * Apps RETIRÉES : plus de sources, plus de paquet. Jumelle de
 * `appstore::RETIRED_APPS` (Rust), qui les désinstalle au démarrage ; ici, le
 * rafraîchissement local (install-apps-local.mjs) les supprime aussi.
 *   - living : « Discussion vivante », remplacée par Luciole ;
 *   - reporting : fusionnée dans « Analyse de données ».
 */
export const RETIRED = ["living", "reporting"];

export const PACKAGES = [
  // ---- Anciens onglets de hubs, désormais des applications à part entière --
  // Chaque page est son propre paquet : une fenêtre par app, plusieurs ouvertes
  // côte à côte, et une maintenance app par app. Les identifiants sont ceux
  // d'origine (notes, kanban, knowledge…) : ce sont aussi les cibles du bus
  // d'interop, qui n'a donc rien à traduire.
  { id: "notes", name: "Notes", category: "create", entry: "notes/notes.html",
    description: "Écrire, réécrire avec l'IA.",
    icon: "notes", gradient: ["#d8a31f", "#d56f9b"], width: 1120, height: 760,
    capabilities: ["ai", "storage", "files", "memory", "interop:opus"],
    intents: [
      { id: "create_note", title: "Créer une note", description: "Crée une note dans le carnet (Markdown accepté) et l'ouvre.",
        parameters: { title: { type: "string", description: "Titre" }, body: { type: "string", description: "Contenu complet de la note" } }, required: ["title", "body"] },
      { id: "append_note", title: "Compléter une note", description: "Ajoute du texte à la fin d'une note existante.",
        parameters: { note: { type: "string", description: "Identifiant ou titre" }, text: { type: "string", description: "Texte à ajouter" } }, required: ["note", "text"] },
      { id: "list_notes", title: "Lister les notes", description: "Liste les notes du carnet, avec un filtre texte optionnel.",
        parameters: { query: { type: "string", description: "Filtre texte optionnel" } }, required: [] },
      { id: "read_note", title: "Lire une note", description: "Lit le contenu complet d'une note.",
        parameters: { note: { type: "string", description: "Identifiant ou titre" } }, required: ["note"] },
      { id: "open_note", title: "Ouvrir une note", description: "Ouvre une note dans l'éditeur, sous les yeux de l'utilisateur.",
        parameters: { note: { type: "string", description: "Identifiant ou titre" } }, required: ["note"] },
    ],
    // Lumen XR : liste des notes dans le casque, une ligne ouvre la note.
    xr: { views: ["list_notes"], detail: { intent: "read_note", arg: "note" } },  },
  { id: "mindmap", name: "Carte mentale", category: "create", entry: "mindmap/mindmap.html",
    description: "Ramifier une idée en carte mentale.",
    icon: "mindmap", gradient: ["#d8a31f", "#d56f9b"], width: 1200, height: 780,
    capabilities: ["ai", "storage", "files", "interop:opus"] },
  { id: "moodboard", name: "Planche", category: "create", entry: "moodboard/moodboard.html",
    description: "Assembler une direction visuelle.",
    icon: "moodboard", gradient: ["#d56f9b", "#d8a31f"], width: 1200, height: 780,
    capabilities: ["ai", "storage", "files", "interop:opus"] },
  { id: "canvas", name: "Canevas créatif", category: "create", entry: "canvas/canvas.html",
    description: "Faire naître des idées par filiation.",
    icon: "canvas", gradient: ["#c75cff", "#d8a31f"], width: 1280, height: 820,
    capabilities: ["ai", "storage", "files", "memory", "interop:opus"] },
  { id: "nodal", name: "Studio Nodal", category: "create", entry: "nodal/nodal.html",
    description: "Workflows génératifs en nœuds : texte, image, vision, audio.",
    icon: "workflow", gradient: ["#6d5dfc", "#c75cff"], width: 1360, height: 860,
    capabilities: ["ai", "storage", "files"] },
  { id: "kanban", name: "Tableau", category: "organize", entry: "kanban/board.html",
    description: "Colonnes, cartes, avancement.",
    icon: "kanban", gradient: ["#7867d8", "#ff5e8a"], width: 1120, height: 760,
    capabilities: ["ai", "storage", "notifications"] },
  { id: "calendar", name: "Agenda", category: "organize", entry: "calendar/calendar.html",
    description: "Échéances et rappels datés.",
    icon: "calendar", gradient: ["#ff5e8a", "#7867d8"], width: 1120, height: 760,
    capabilities: ["ai", "storage", "notifications"] },
  // ---- Communication (sorties du noyau le 23/09/2026) -------------------
  { id: "mail", name: "Email", category: "comm", entry: "mail/mail.html",
    description: "Votre courrier en IMAP/SMTP, affiché sans risque, résumé et préparé par l'IA.",
    icon: "mail", gradient: ["#0a84ff", "#5e5ce6"], width: 1180, height: 780,
    capabilities: ["ai", "storage", "network", "notifications", "interop:contacts"] },
  { id: "contacts", name: "Contacts", category: "people", entry: "contacts/contacts.html",
    description: "Le carnet d'adresses unique : courrier, Relia et Telegram réunis.",
    icon: "users", gradient: ["#16b8a6", "#0a84ff"], width: 1060, height: 740,
    capabilities: ["storage", "interop:mail"] },
  { id: "morning", name: "Matin", category: "organize", entry: "morning/morning.html",
    description: "L'écran de la journée : agenda, messages, tâches, nuit des agents.",
    icon: "sun", gradient: ["#ff9f0a", "#ff375f"], width: 1100, height: 760,
    capabilities: ["storage"] },
  // ---- Poste d'étudiant (23/09/2026) --------------------------------------
  { id: "studies", name: "Études", category: "organize", entry: "studies/studies.html",
    description: "Fiches à répétition espacée, quiz, podcasts de révision, bibliothèque de cours libres, planning d'examens et correction expliquée, générés à partir de vos cours — hors ligne avec un modèle local.",
    icon: "book-open", gradient: ["#30d158", "#0a84ff"], width: 1180, height: 800,
    capabilities: ["ai", "storage", "files", "network", "notifications", "interop:pdf"],
    intents: [
      { id: "studies_due", title: "Fiches à réviser", description: "Nombre de fiches de révision à revoir aujourd'hui, par matière.", parameters: {}, required: [] },
      { id: "studies_exams", title: "Examens à venir", description: "Liste des examens à venir enregistrés dans Études.", parameters: {}, required: [] },
      { id: "studies_add_course", title: "Ajouter un cours", description: "Ajoute un texte de cours à une matière d'Études (créée si besoin), pour en générer fiches et quiz.",
        parameters: { course: { type: "string", description: "Matière" }, title: { type: "string", description: "Titre du cours" }, text: { type: "string", description: "Texte complet du cours" } }, required: ["course", "title", "text"] },
    ] },
  { id: "pdf", name: "PDF", category: "create", entry: "pdf/pdf.html",
    description: "Lire, surligner, annoter et signer vos PDF ; copie annotée lisible partout.",
    icon: "pdf", gradient: ["#ff453a", "#ff9f0a"], width: 1240, height: 840,
    capabilities: ["ai", "storage", "files", "interop:studies"] },
  // Studio de montage façon CapCut (08/10/2026) : pistes, transitions,
  // filtres, textes animés, sous-titres Whisper, voix off, assistant IA.
  { id: "media", name: "Médias", category: "create", entry: "media/media.html",
    description: "Lecteur vidéo et musique, et studio de montage : pistes multiples, transitions, filtres, textes animés, sous-titres automatiques, voix off et assistant IA.",
    icon: "play", gradient: ["#ff375f", "#bf5af2"], width: 1360, height: 860,
    capabilities: ["ai", "storage", "files"],
    intents: [
      { id: "media_create_montage", title: "Créer un montage vidéo", description: "Monte automatiquement une vidéo dans Médias à partir de vidéos/photos des sandboxes (transitions, filtre, titre, musique calée sur le rythme, sous-titres en option).",
        parameters: {
          files: { type: "array", items: { type: "string" }, description: "Noms des fichiers vidéo/photo à utiliser (facultatif)" },
          query: { type: "string", description: "Sinon, mots-clés pour trouver les fichiers (ex. « vacances »)" },
          style: { type: "string", enum: ["dynamic", "vlog", "cinematic", "calm"], description: "Style" },
          aspect: { type: "string", enum: ["16:9", "9:16", "1:1", "4:5"], description: "Format (9:16 = Reels/TikTok)" },
          duration: { type: "number", description: "Durée visée en secondes" },
          title: { type: "string", description: "Titre affiché au début" },
          music: { type: "string", description: "Musique (nom de fichier)" },
          captions: { type: "boolean", description: "Ajouter des sous-titres automatiques" },
        }, required: [] },
      { id: "media_edit", title: "Retoucher le montage", description: "Applique une consigne de montage en langage naturel au projet ouvert dans Médias (couper, textes, transitions, filtres, musique, sous-titres…).",
        parameters: { instruction: { type: "string", description: "Consigne, ex. « ajoute un titre et passe en 9:16 »" } }, required: ["instruction"] },
      { id: "media_export", title: "Exporter la vidéo", description: "Exporte le montage ouvert dans Médias en MP4 dans une sandbox.",
        parameters: { quality: { type: "integer", description: "Résolution (720, 1080…)" } }, required: [] },
      { id: "media_project", title: "Résumé du montage", description: "Décrit le montage ouvert dans Médias (clips, textes, pistes audio, durée).", parameters: {}, required: [] },
    ] },
  { id: "photos", name: "Photos", category: "create", entry: "photos/photos.html",
    description: "La bibliothèque de toutes les images de vos sandboxes.",
    icon: "image", gradient: ["#3b9cff", "#c75cff"], width: 1180, height: 780,
    capabilities: ["storage", "files", "interop:moodboard", "interop:opus"] },
  { id: "scheduler", name: "Tâches planifiées", category: "organize", entry: "scheduler/scheduler.html",
    description: "Tout ce qui s'exécute à heure fixe : demandes à l'IA, workflows, agents, rappels.",
    icon: "clock", gradient: ["#2aa876", "#7867d8"], width: 1080, height: 720,
    capabilities: ["ai", "storage", "notifications"],
    intents: [
      { id: "create_scheduled_task", title: "Planifier une tâche", description: "Planifie une tâche récurrente ou datée : une demande à l'IA (kind=ai, avec prompt), un workflow Fluxo (kind=workflow, avec workflow), un agent (kind=agent, avec agent) ou un rappel (kind=reminder). Fréquence : every = once|day|week|minutes|hours|month|cron.",
        parameters: {
          title: { type: "string", description: "Titre court" },
          kind: { type: "string", enum: ["ai", "workflow", "agent", "reminder"], description: "Nature de la tâche" },
          prompt: { type: "string", description: "Demande à l'IA ou à l'agent" },
          workflow: { type: "string", description: "Nom exact du workflow Fluxo (kind=workflow)" },
          agent: { type: "string", description: "Nom exact de l'agent (kind=agent)" },
          every: { type: "string", enum: ["once", "day", "week", "minutes", "hours", "month", "cron"], description: "Fréquence" },
          time: { type: "string", description: "Heure HH:MM" },
          date: { type: "string", description: "Date AAAA-MM-JJ (every=once)" },
          days: { type: "array", items: { type: "integer" }, description: "Jours de semaine 0=dim…6=sam (every=week)" },
          n: { type: "integer", description: "Intervalle (every=minutes|hours)" },
          cron: { type: "string", description: "Expression CRON 6 champs (every=cron)" },
        }, required: ["title", "every"] },
      { id: "list_scheduled_tasks", title: "Lister les tâches planifiées", description: "Liste les tâches planifiées (IA, workflows, agents, rappels) avec leur fréquence et leur prochaine exécution.",
        parameters: {}, required: [] },
      { id: "run_scheduled_task", title: "Lancer une tâche planifiée", description: "Exécute immédiatement une tâche planifiée par son titre.",
        parameters: { task: { type: "string", description: "Titre exact de la tâche" } }, required: ["task"] },
    ] },
  { id: "tables", name: "Bases de données", category: "data", entry: "tables/tables.html",
    description: "Bases locales interrogeables en langage naturel.",
    icon: "tables", gradient: ["#168f82", "#5e5ce6"], width: 1280, height: 820,
    capabilities: ["ai", "storage", "tables", "files"] },
  // Analyse de données absorbe l'ancien Reporting (08/10/2026) : mini Power BI
  // local — rapports multipages, segments, filtre croisé, période comparée,
  // export PDF/HTML, envoi et abonnements par email (report_subs.rs).
  { id: "dataanalysis", name: "Analyse de données", category: "data", entry: "data-analysis/analysis.html",
    description: "Rapports et tableaux de bord façon Power BI : visuels, segments, filtres croisés, période comparée, export PDF et envoi automatique par email.",
    icon: "dataanalysis", gradient: ["#5e5ce6", "#168f82"], width: 1360, height: 860,
    capabilities: ["ai", "storage", "tables", "files"],
    intents: [
      { id: "analyze_data", title: "Analyser des données", description: "Répond à une question chiffrée sur les données du rapport ouvert dans Analyse de données (calculs exacts sur les tables du modèle).",
        parameters: { question: { type: "string", description: "Question, ex. « quelle région a le plus vendu en mars ? »" } }, required: ["question"] },
      { id: "create_dashboard", title: "Créer un tableau de bord", description: "Construit dans Analyse de données une page de visuels (indicateurs, graphiques, segments) à partir des tables du rapport ouvert.",
        parameters: { goal: { type: "string", description: "Ce que le tableau de bord doit montrer" } }, required: [] },
      { id: "send_report", title: "Envoyer un rapport par email", description: "Exporte le rapport ouvert dans Analyse de données (PDF ou HTML) et l'envoie par email en pièce jointe.",
        parameters: { to: { type: "string", description: "Destinataires, séparés par des virgules" }, subject: { type: "string", description: "Objet" }, format: { type: "string", enum: ["pdf", "html"], description: "Format de la pièce jointe" } }, required: ["to"] },
      { id: "report_send", title: "Exécuter un envoi programmé", description: "Usage interne : envoie l'abonnement indiqué.",
        parameters: { id: { type: "string", description: "Identifiant de l'abonnement" } }, required: ["id"] },
    ] },
  { id: "ml", name: "Atelier ML", category: "lab", pack: "ml", prerequisites: "Environ 1 Go pour Pyodide et les modèles transformers.js téléchargés à la demande.", entry: "ml/ml.html",
    description: "Entraîner un modèle localement.",
    icon: "ml", gradient: ["#168f82", "#0a84ff"], width: 1280, height: 820,
    capabilities: ["ai", "storage", "tables", "files"] },
  { id: "knowledge", name: "Corpus", category: "search", entry: "knowledge/knowledge.html",
    description: "Vos documents indexés (RAG).",
    icon: "knowledge", gradient: ["#37a87a", "#3a9baa"], width: 1180, height: 800,
    capabilities: ["ai", "storage", "files", "memory"] },
  // ---- Carte assistée par IA (24/09/2026) -----------------------------------
  { id: "carte", name: "Carte", category: "search", entry: "carte/carte.html",
    description: "Carte assistée par IA : extraction OpenStreetMap, jeux de données data.gouv.fr, fonds IGN et export GeoJSON crédité.",
    icon: "map-pin", gradient: ["#ff375f", "#16b8a6"], width: 1280, height: 820,
    capabilities: ["ai", "storage", "files", "network"],
    intents: [
      { id: "carte_show", title: "Afficher sur la carte", description: "Demande en langage naturel à l'app Carte : se déplacer vers un lieu, extraire des objets OpenStreetMap (pharmacies, parcs…) ou chercher un jeu de données data.gouv.fr.",
        parameters: { request: { type: "string", description: "Ce que l'utilisateur veut voir, ex. « les musées de Lyon »" } }, required: ["request"] },
      { id: "carte_layers", title: "Couches de la carte", description: "Résumé des couches affichées dans l'app Carte (nombre d'objets, exemples, sources).", parameters: {}, required: [] },
    ] },
  { id: "research", name: "Enquête", category: "search", entry: "research/research.html",
    description: "Un agent fouille et rend un rapport sourcé.",
    icon: "research", gradient: ["#3a9baa", "#37a87a"], width: 1180, height: 800,
    capabilities: ["ai", "storage", "files", "network", "memory"] },
  { id: "podcast", name: "Podcast", category: "audio", entry: "podcast/podcast.html",
    description: "Vos docs en discussion à deux voix.",
    icon: "podcast", gradient: ["#ff6a3d", "#19c3ff"], width: 1200, height: 800,
    capabilities: ["ai", "storage", "files"] },
  { id: "voicelab", name: "Voix", category: "audio", entry: "voicelab/voicelab.html",
    description: "Essayer et gérer les voix locales.",
    icon: "voicelab", gradient: ["#19c3ff", "#ff6a3d"], width: 1100, height: 760,
    capabilities: ["ai", "storage", "files"] },
  { id: "games", name: "Jeux", category: "play", pack: "loisirs", prerequisites: "Aucun.", entry: "games/games.html",
    description: "Mini-jeux.",
    icon: "games", gradient: ["#ff5e8a", "#7c5cff"], width: 1160, height: 790,
    capabilities: ["ai", "storage"] },
  { id: "adventure", name: "Aventure", category: "play", pack: "loisirs", prerequisites: "Un modèle de langage local ou une API ; génération d’images facultative.", entry: "adventure/adventure.html",
    description: "Jeu de rôle textuel illustré.",
    icon: "adventure", gradient: ["#7c5cff", "#ff5e8a"], width: 1160, height: 790,
    capabilities: ["ai", "storage", "memory"] },
  { id: "aipet", name: "Luciole", category: "play", pack: "loisirs", prerequisites: "Aucun.", entry: "aipet/aipet.html",
    description: "Une petite lumière qui vit, joue et se souvient de vous.",
    icon: "aipet", gradient: ["#ff9f0a", "#ff5e8a"], width: 1000, height: 760,
    capabilities: ["ai", "storage", "memory"] },
  { id: "editor", name: "Éditeur de code", category: "lab", pack: "dev", prerequisites: "Aucun.", entry: "editor/editor.html",
    description: "Éditer le code des apps HTML.",
    icon: "editor", gradient: ["#7c3aed", "#0ea5e9"], width: 1240, height: 800,
    capabilities: ["ai", "storage", "files"] },
  // Python : l'interpréteur (Pyodide, CPython en WebAssembly) est EMBARQUÉ dans
  // le paquet (src/python/vendor, ~12 Mo) pour tourner hors ligne ; il vit dans
  // un Web Worker et ne voit que les fichiers de la sandbox. Les bibliothèques
  // scientifiques viennent du CDN Pyodide au premier import.
  // Portage de Rpi-Robot-Studio (MIT, même auteur) : blocs → Python → SSH.
  { id: "robotstudio", name: "Robot Studio", category: "lab", pack: "robotique", prerequisites: "Un Raspberry Pi joignable en SSH (pigpiod) et son câblage.", entry: "robotstudio/robotstudio.html",
    description: "Programmer un Raspberry Pi par blocs : capteurs, moteurs, LED, réseau et IA, Python généré puis déployé et lancé sur le Pi en SSH.",
    icon: "cpu", gradient: ["#BC3657", "#5C6BC0"], width: 1320, height: 860,
    capabilities: ["ai", "storage", "files", "network"] },
  { id: "python", name: "Python", category: "lab", pack: "dev", prerequisites: "Aucun : interpréteur Pyodide embarqué (≈ 30 Mo).", entry: "python/python.html",
    description: "Écrire et exécuter du Python dans un interpréteur isolé.",
    icon: "terminal", gradient: ["#3572A5", "#ffd43b"], width: 1280, height: 820,
    capabilities: ["ai", "storage", "files", "network"],
    intents: [
      { id: "run_python", title: "Exécuter du Python", description: "Exécute un script Python dans l'interpréteur isolé de Lumen (numpy, pandas, matplotlib disponibles ; les fichiers de la sandbox sont accessibles dans le répertoire courant) et renvoie la sortie.",
        parameters: { code: { type: "string", description: "Code Python complet à exécuter" }, stdin: { type: "string", description: "Entrée standard optionnelle, une ligne par input()" } }, required: ["code"] },
    ] },

  // ---- Applications d'un seul tenant ------------------------------------
  // Opus (documents/présentations) et Calc (tableur) ne sont PAS packagés en 0.2 :
  // ce ne sont pas des pages autonomes mais des fenêtres dessinées par le shell
  // lui-même (src/sandbox/creative-editor.js, src/sandbox/sheets.js). Les
  // extraire demande de leur écrire un hôte à part, pas de zipper un dossier.
  // Ils restent donc au noyau tant que ce port n'est pas fait.
  { id: "imagestudio", name: "Studio d'images", category: "create", entry: "studio/studio.html",
    description: "Génération d'images locale (Bonsai, Ollama ou API).",
    icon: "image", gradient: ["#6570c8", "#d79577"], width: 1080, height: 720,
    capabilities: ["ai", "storage", "files"] },
  { id: "musicstudio", name: "Studio musical", category: "audio", pack: "audio-creation", prerequisites: "Aucun : synthèse Web Audio, sans modèle.", entry: "musicstudio/studio.html",
    description: "Studio musical génératif : presets, séquenceur, export WAV.",
    icon: "music", gradient: ["#7c5cff", "#19c3ff"], width: 1180, height: 800,
    capabilities: ["ai", "storage", "files"] },
  { id: "browser", name: "Navigateur", category: "search", entry: "browser/browser.html",
    description: "Naviguer sur le web, avec résumé, traduction, analyse par l'IA et un agent qui agit dans la page.",
    icon: "globe", gradient: ["#2f9fe8", "#0a84ff"], width: 1180, height: 780,
    capabilities: ["ai", "storage", "network", "files"],
    intents: [
      { id: "browser_do", title: "Agir dans le navigateur", description: "Accomplit une tâche sur le web dans le Navigateur de Lumen, comme une personne : ouvrir des pages, chercher, cliquer, remplir des champs (jamais de mot de passe ni de paiement sans accord explicite de l'utilisateur). Renvoie un compte rendu.",
        parameters: { goal: { type: "string", description: "La tâche à accomplir, précise (site, informations voulues)" }, url: { type: "string", description: "Adresse de départ (facultatif)" } }, required: ["goal"] },
    ] },
  { id: "budget", name: "Budget", category: "organize", entry: "budget/budget.html",
    description: "Dépenses, objectifs et conseils de l'IA.",
    icon: "chart", gradient: ["#30d158", "#0a84ff"], width: 1180, height: 780,
    capabilities: ["ai", "storage", "tables"] },
  { id: "calculator", name: "Calculatrice", category: "data", entry: "calculator/calculator.html",
    description: "Calculatrice scientifique, statistiques et conversions d'unités ; même moteur que l'outil de calcul de l'IA.",
    icon: "calculator", gradient: ["#636366", "#ff9f0a"], width: 760, height: 620,
    capabilities: ["storage"] },
  { id: "domotique", name: "Domotique", category: "lab", pack: "maison", prerequisites: "Des objets ESP32/Pico sous MicroPython sur le réseau local.", entry: "domotique/domotique.html",
    description: "Objets connectés, pièces, scènes, automatisations et firmwares ESP32/Pico.",
    icon: "cpu", gradient: ["#2aa98f", "#2670c9"], width: 1180, height: 780,
    capabilities: ["ai", "storage", "network", "files", "notifications"],
    intents: [
      { id: "run_scene", title: "Lancer une scène domotique", description: "Lance une scène enregistrée dans Domotique (plusieurs commandes d'objets d'un coup), par son nom.",
        parameters: { scene: { type: "string", description: "Nom de la scène (ex. Soirée, Je pars)" } }, required: ["scene"] },
      { id: "list_scenes", title: "Lister les scènes domotiques", description: "Liste les scènes enregistrées dans Domotique.", parameters: {}, required: [] },
    ] },
  { id: "village", name: "Village", category: "play", pack: "loisirs", prerequisites: "Aucun ; les agents d’Équipe s’y affichent s’ils existent.", entry: "village/village.html",
    description: "Le village des agents : décor vivant et objets à câbler.",
    icon: "map", gradient: ["#37a87a", "#d8a31f"], width: 1280, height: 840,
    capabilities: ["ai", "storage"] },

  // ---- Applications de l'édition Pro ------------------------------------
  { id: "relia", name: "Relia", category: "people", entry: "crm/crm.html",
    description: "CRM assisté par l'IA : projets, tâches, clients, devis et factures Factur-X.",
    icon: "file-text", gradient: ["#0a84ff", "#5e5ce6"], width: 1240, height: 820,
    capabilities: ["ai", "storage", "tables", "files", "notifications"] },
  { id: "meet", name: "Réunion", category: "comm", entry: "meet/meet.html",
    description: "Visio et chat d'équipe sur votre réseau, avec compte rendu par l'IA.",
    icon: "users", gradient: ["#0a84ff", "#16b8a6"], width: 1320, height: 860,
    capabilities: ["ai", "storage", "network", "notifications", "interop:kanban"] },
  { id: "dbstudio", name: "DB Studio", category: "data", entry: "dbstudio/dbstudio.html",
    description: "Modéliser une base : tables, champs typés, relations et formulaires.",
    icon: "database", gradient: ["#5e5ce6", "#30d158"], width: 1300, height: 850,
    capabilities: ["ai", "storage", "tables"] },
  { id: "etl", name: "Flux de données", category: "data", entry: "etl/etl.html",
    description: "ETL visuel : sources, transformations et destinations reliées sur un canevas.",
    icon: "trending-up-down", gradient: ["#16b8a6", "#ff9f0a"], width: 1320, height: 860,
    capabilities: ["ai", "storage", "tables", "network"] },
  { id: "datasources", name: "Sources de données", category: "data", entry: "datasources/datasources.html",
    description: "Centre de connexions : bases, partages et API mis à disposition des apps Pro.",
    icon: "plug", gradient: ["#16b8a6", "#5e5ce6"], width: 1300, height: 850,
    capabilities: ["storage", "tables", "network"] },
  { id: "directory", name: "Annuaire", category: "people", entry: "directory/directory.html",
    description: "Les personnes du réseau : présence, messages et invitations en réunion.",
    icon: "users", gradient: ["#0a84ff", "#16b8a6"], width: 980, height: 760,
    capabilities: ["storage", "network", "notifications"] },
  { id: "messages", name: "Messagerie d'équipe", category: "comm", entry: "messages/messages.html",
    description: "Conversations chiffrées de bout en bout avec votre équipe.",
    icon: "messages-square", gradient: ["#5e5ce6", "#0a84ff"], width: 1180, height: 820,
    capabilities: ["storage", "network", "notifications"] },
];

/**
 * Applications du noyau : jamais packagées, jamais désinstallables.
 * Le packager s'en sert de garde-fou — sortir l'une d'elles par mégarde
 * donnerait un Lumen qui ne sait plus s'ouvrir.
 */
export const CORE_APPS = [
  "assistant", "sandbox", "crew", "fluxo", "inbox", "documents", "presentations", "calc",
  "memory", "tour", "keys", "storage", "settings", "market", "docs",
];
