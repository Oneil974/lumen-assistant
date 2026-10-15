# Journal des versions

Les notes de la section correspondant à `version` (src-tauri/tauri.conf.json)
sont reprises telles quelles par `scripts/release.mjs` dans `latest.json` :
c'est ce que l'updater affiche aux utilisateurs.

## 0.3.0

Octobre 2026

### Assistant et intelligence
- **Mode d'affichage Application** — une interface façon application de chat, en plus de la barre et du bureau.
- **Routeur par modèle de décision** — un petit modèle choisit entre réponse directe, outils ou orchestration.
- **Mode orchestration et harnais** — les demandes complexes sont découpées en étapes vérifiées.
- **Mode hybride** — en cas d'échec du modèle local, Lumen propose d'escalader vers un modèle API (avec votre accord).
- **Nouveaux modèles** et **mise à jour de llama.cpp**.
- **Sélecteur de modèles et de backends** amélioré.
- **Commande vocale**.

### Agents
- **Messagerie instantanée** avec les agents.
- **Design des agents** amélioré.
- **Prise en charge de Slack**.

### Applications
- **Nouvelles applications** — Navigateur, Calculatrice, Études (bêta), éditeur de PDF.
- **Carnet d'adresses, E-mail et vue du matin**.
- **Documents et Présentations** améliorés, avec de nouveaux modèles.
- **Prise de notes sur PDF**.
- **Analyse de données** et **Atelier ML** améliorés.
- **RPI Robot Studio**.
- **Nouveaux widgets**.
- **« Envoyer vers… »** amélioré.
- **Diagnostic** — nouvelle fonctionnalité de diagnostic.

### Interface et plateformes
- **Orbes colorés** et améliorations de l'orbe.
- **Réalité augmentée** — testée sur casque Meta Quest 3S.
- **Traduction EN/FR** améliorée.

### Corrections
- Nombreuses corrections de bugs, dont : envoi d'images vers les applications, performances sous Windows, affichage de l'export PDF.

## 0.2.0

Septembre 2026 — la version qui fait de Lumen Desktop un système : un noyau allégé, des apps en paquets installables depuis un Catalogue, un assistant qui travaille en projets, et une présence sur mobile et Raspberry Pi.

### Assistant et conversations
- **Dossiers de conversations** — organisez vos discussions par dossier ; un dossier accueille aussi les résumés produits par l'IA.
- **Conversations épinglées** — un tableau façon Pinterest conserve les discussions importantes à portée de main.
- **Export PDF** — une conversation s'exporte en PDF depuis le menu ou par un appel d'outil du modèle.
- **Mentions `@` et `#`** — mentionner un outil ou un document dans la barre de chat force son appel directement, quel que soit le mode.
- **Fenêtre de prompt flottante** et **menu contextuel** — interrogez le modèle depuis n'importe quelle application sur une sélection de texte.
- **Comprendre l'écran par zone** — sélectionnez une région de l'écran et faites-la analyser par le modèle vision, en plus de la capture complète.
- **Assistant de création d'agent** — un parcours guidé pour définir un agent personnel (rôle, outils, garde-fous).
- **Application Assistant IA** revue, et **boîte d'assistant** intégrée dans plusieurs applications (Calendrier avec prompts IA, Notes, tableaux…).

### Applications et Catalogue
- **Catalogue** — un seul écran pour installer modèles, workflows Fluxo, avatars, voix et applications.
- **Nouvelles applications** — Photos (bibliothèque de toutes les images de vos sandboxes), Python (interpréteur intégré), Tâches planifiées (demandes IA, workflows, agents et rappels dans une seule vue).
- **Atelier ML** enrichi — datasets CSV, algorithmes scikit-learn, métriques, kit Raspberry Pi.
- **Commande vocale du bureau** (option, désactivée par défaut) — maintenez ⌥Espace et parlez : ouvrir une app, chercher ou ouvrir un fichier, lancer un workflow, changer de thème, fermer une fenêtre, ou « demande à Lumen… ». Compris hors ligne sans outils supplémentaires dans les conversations ; routeur IA optionnel ; commande aussi depuis le compagnon mobile (bouton « Bureau »).
- **Capsule Halo** — une capsule persistante affiche les agents en cours, les notifications et l'heure.
- **Recherche web** améliorée — extraction plus fiable des pages et des documents.
- **Interface** — refonte globale : système de conception unifié clair/sombre, icônes et actions simplifiées (le bouton « + » remplace l'icône supplémentaire).

### Moteurs et modèles
- **Bonsai Image** — le moteur de génération d'images PrismML est intégré et se télécharge à la demande (Apple Silicon, GPU NVIDIA).
- **Apple Foundation Models** — sur macOS 27, le modèle Apple sur l'appareil devient un moteur à part entière, appels d'outils compris.
- **Apple Image Playground** — génération d'images via le service système sur macOS 27.
- **Voix** — choix de la voix de synthèse (Piper et autres) dès l'assistant de premier démarrage.

### Mobile et accès distant
- **Progressive Web App** — Lumen s'utilise à distance depuis un navigateur ou un téléphone, installable sur l'écran d'accueil.
- **Compagnon mobile** modernisé — multi-utilisateur, capture photo pour le modèle vision, suivi et approbation des agents, notifications push.

### Édition Pro (en préparation)
Cette version prépare une édition Pro, destinée à un usage professionnel et en équipe. Un seul binaire : les fonctions Pro se débloquent avec une clé de licence vérifiée hors ligne, sans compte ni connexion.
- **Relia** — CRM assisté par l'IA : projets, tâches, clients, devis et factures Factur-X.
- **Réunion** — visio et chat d'équipe sur votre réseau local, avec compte rendu rédigé par l'IA.
- **DB Studio** — modélisation de bases de données : tables, champs typés, relations et formulaires.
- **Flux de données** — ETL visuel : sources, transformations et destinations reliées sur un canevas.
- **Reporting** — rapports d'entreprise (indicateurs, graphiques, export) construits avec l'IA.
- **Sources de données** — centre de connexions (bases, partages, API) mis à disposition des apps Pro.
- **Annuaire** et **Messagerie d'équipe** — les personnes du réseau, leur présence, et des conversations chiffrées de bout en bout.
- **Lumen Server** — un serveur d'équipe optionnel (rôles et permissions, source d'IA partagée) vers lequel les postes Lumen peuvent se connecter.

### Corrections
- **Windows** — bibliothèques CUDA manquantes au lancement de llama-server (`cublas`) désormais embarquées ; repli CPU si elles sont absentes.
- **Linux** — correctifs CUDA et rendu graphique (transparence et flou WebKitGTK).
- **Assistant** — détection du backend d'inférence fiabilisée.
- **Opus** — barre de titre et ruban sur toute la largeur, panneaux Pages et Inspecteur placés en dessous et repliables (état mémorisé par app).
- **Opus** — le texte en cours de frappe (ou collé) est validé avant tout redimensionnement, rotation ou déplacement : la première poignée tirée après un collage ne vide plus le bloc. Le collage depuis le chat ne rapporte plus les styles ni les blocs de la bulle, seulement le texte et sa mise en forme inline.
- **Envoyer vers…** — un texte simple ne produit plus un document vide dans Opus (le Markdown rendu sans balise de bloc n'était pas repris) ; le sélecteur fonctionne désormais depuis la barre principale : l'objet est relayé au bureau, gardé des deux côtés tant qu'il n'est pas livré (bureau fermé, ou session à déverrouiller) et remis dès l'ouverture de la session ; il ne propose plus d'app désinstallée ; une confirmation s'affiche après l'envoi. Corpus indexe le contenu réel d'un fichier reçu (PDF, Word, tableur) au lieu de son chemin, Analyse de données lit le CSV dans SA sandbox, et Planche accepte une image désignée par son chemin.
- **Opus** — une image envoyée depuis Photos ou le menu contextuel devient un vrai élément image (le document n'affichait que la date) ; le sélecteur « Insérer une image » propose toutes les sandboxes, et chaque image se recharge depuis la sienne.
- **Barre de chat** — la barre d'export PDF ne déborde plus de la fenêtre et ne recouvre plus les boutons « + » des messages.
- **Traduction anglaise** — écran de connexion, menu « @ » (descriptions courtes des outils), Réglages › Boîte à outils, sélecteur « Envoyer vers… », et près de 1 500 chaînes d'applications (Opus, Calc, Profiler, Atelier ML, Catalogue, Reporting, DB Studio…) ; les consignes des apps demandent au modèle de répondre dans la langue de l'interface. Le compagnon mobile est bilingue (langue du téléphone, ou choix dans ses Réglages).

## 0.1.1

Août 2026 — voir le journal en ligne : https://oneil974.github.io/lumen-assistant/changelog.html

## 0.1.0

Juillet 2026 — première version publique.
