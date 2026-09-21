# Lumen Assistant

[English](README.md) · **Français**

<p align="center">
  <img src="assets/Lumen_screen_win.png" alt="Lumen sous Windows — la barre flottante, l’orbe et une conversation avec un modèle local (llama.cpp, Gemma)" width="690">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/statut-b%C3%AAta-ff9e6b" alt="Statut : bêta">
  <a href="https://github.com/Oneil974/lumen-assistant/releases/latest"><img src="https://img.shields.io/github/v/release/Oneil974/lumen-assistant?label=version&color=9961ff" alt="Dernière version"></a>
  <img src="https://img.shields.io/badge/plateformes-macOS%20·%20Windows%20·%20Linux%20·%20Raspberry%20Pi-47a3ff" alt="Plateformes">
  <img src="https://img.shields.io/badge/IA-100%25%20locale%20possible-61f2c7" alt="Local-first">
  <img src="https://img.shields.io/badge/donn%C3%A9es-sur%20votre%20machine-ff54a3" alt="Données privées">
</p>

<p align="center"><img src="assets/divider.svg" alt="" width="700"></p>

**Un assistant IA de bureau local-first — une barre de chat vivante, privée et agentique, qui grandit jusqu'à devenir un bureau complet.**

Lumen embarque son propre moteur d'inférence : **rien à installer** pour commencer à parler à un modèle local. Il sait aussi utiliser [Ollama](https://ollama.com), les modèles d'Apple, ou une API compatible OpenAI quand un modèle cloud est plus adapté — chaque source gardant son propre modèle. La version **0.2** fait de Lumen Desktop un système : un noyau allégé, des apps en paquets installables depuis un Catalogue, un assistant qui travaille en projets, et une présence sur votre téléphone et sur Raspberry Pi.

➡️ **[Télécharger la dernière version](https://github.com/Oneil974/lumen-assistant/releases/latest)** · 🌐 **[Site de présentation](https://Oneil974.github.io/lumen-assistant/)** · 📝 **[Journal des versions](https://Oneil974.github.io/lumen-assistant/changelog.html)**

> [!NOTE]
> **Lumen est en bêta, en développement actif.** Les fonctionnalités évoluent vite d'une version à l'autre et des bugs peuvent subsister. Vos retours sont bienvenus via les [issues](https://github.com/Oneil974/lumen-assistant/issues).

---

## ✨ Une barre vivante

Une capsule de chat flottante, toujours à portée de main, avec un **orbe animé** qui respire, écoute et réagit.

- **Quatre moteurs** — llama.cpp embarqué (rien à installer), Ollama local, modèles Apple — sur macOS 27, le modèle sur l'appareil des **Apple Foundation Models**, appels d'outils compris, rien à télécharger — ou API compatible OpenAI. On change de source en un clic, chacune retrouvant son modèle.
- **Orbe ou avatar** — l'orbe de verre WebGL, ou votre propre modèle **GLB animé** dont les animations suivent les états de l'assistant.
- **Modes de discussion** — chat direct, **Documents** (vos fichiers indexés), routeur d'actions, tool calling, ou un workflow précis.
- **Comprendre cet écran** — Lumen capture l'écran réel, ou seulement la zone que vous sélectionnez, et le fait décrire par le modèle vision actif.
- **Prompt flottant & menu contextuel** — sélectionnez du texte dans n'importe quelle application : relisez, réécrivez, résumez ou traduisez depuis le menu contextuel, ou ouvrez une feuille de prompt flottante sur place.
- **Projets, dossiers, épingles & PDF** — regroupez vos conversations dans un projet avec des instructions et une base de connaissances locale ; rangez-les en dossiers, épinglez les importantes sur un tableau façon Pinterest, exportez n'importe quel fil en PDF. Résumez, compactez ou créez une branche depuis n'importe quel message.
- **Mentions @ et #** — mentionnez un outil ou un document dans la barre de chat pour forcer son appel, quel que soit le moteur.
- **Voix & dictée** — **Piper est livré dans l'application** (Linux, Windows), plus Kokoro, les voix système et la dictée whisper.cpp. 100 % hors-ligne possible.
- **Mémoire** — huit types de souvenirs, rappel avant de répondre, politique d'accès cloisonnée appliquée côté backend.
- **Capsule Halo & notifications** — une capsule persistante affiche les agents en cours et leurs étapes, les notifications, la météo et les scores ; chaque type d'événement a son son et son signal sur l'orbe.
- **Compagnon mobile (PWA) & Telegram** — installez Lumen sur l'écran d'accueil du téléphone : multi-utilisateur avec un code TOTP par profil, capture photo pour le modèle vision, approbation des agents et notifications push. Ou joignez l'assistant depuis Telegram sans ouvrir un seul port.

## 🖥️ Lumen Desktop — le bureau immersif

Un environnement de travail complet dans une fenêtre : session multi-profils, fenêtres, widgets, Spotlight (⌘K), centre de notifications, thèmes clair/sombre — et, depuis la 0.2, **un noyau allégé avec des apps en paquets installables**.

<p align="center">
  <img src="assets/Lumen_Desktop_0.2.0.png" alt="Lumen Desktop 0.2 sous Windows — launcher, Catalogue, sandboxes, Python, Documents et Notes côte à côte" width="700">
  <br>
  <sub><em>Lumen Desktop 0.2 sous Windows : le launcher et ses catégories, le Catalogue (modèles, voix, workflows, avatars), un explorateur de sandbox, l'app Python, Documents et Notes — plusieurs apps ouvertes à la fois, chacune dans sa fenêtre.</em></sub>
</p>

- **Catalogue** — un seul écran pour installer les apps (paquets `.lumenapp` servis par un dépôt signé), les modèles GGUF, les voix, les workflows Fluxo et les avatars. Chaque app déclare ses capacités ; vous les accordez une à une.
- **App Intents** — les apps promeuvent des actions à l'assistant (créer une note, planifier une tâche, exécuter du Python) : le modèle peut les appeler même app fermée.
- **Barre d'icônes & launcher** — une barre compacte qui s'efface, un launcher plein écran, et un menu d'apps que vous rangez vous-même.
- **Sandbox IA** — des espaces fichiers isolés où les agents lisent, écrivent et exécutent sans toucher au reste de la machine.
- **Corpus (RAG)** — indexez vos documents, interrogez-les en langage naturel, et voyez les passages sur lesquels repose chaque réponse, avec leur score.
- **Bases de données** — tables SQLite façon Baserow, requêtes en langage naturel (lecture seule), intégrées aux autres apps.
- **Mode consultation** *(alpha)* — une interface apaisée, pensée pour le tactile, sur écran partagé ou tablette.
- **Forge** — décrivez une app, Lumen la génère, vous la codez — sans changer de fenêtre.

## 🤖 Agents, Fluxo & Skills

- **Assistant de création d'agent** — un parcours guidé pour définir un agent personnel : rôle, outils, budgets et garde-fous.
- **Orchestrateur & sous-agents** — un agent principal découpe une demande et délègue à des spécialistes, avec budgets de tokens et d'itérations, et escalade au lieu de boucler.
- **Tâches planifiées** — une vue unique sur tout ce qui s'exécute à heure fixe : demandes à l'IA, workflows, agents et rappels, avec journal.
- **Mode Automation** — une version à base de nœuds de Fluxo pour les automatisations planifiées et déclenchées par événement, avec leur historique d'exécution.
- **Designer Fluxo** — éditeur visuel de workflows : déclencheurs, actions système, blocs IA, notifications.
- **Connecteurs MCP** — les serveurs Model Context Protocol se branchent en un clic (distants officiels, HTTPS avec jeton en en-tête).
- **Boîte à outils** — vous choisissez les outils publiés au modèle, un par un : un outil inutile coûte du contexte avant même votre question.
- **Recherche web activable** — désactivée par défaut ; rien ne part en ligne tant que vous ne l'allumez pas. L'extraction des pages et des documents est plus fiable en 0.2.
- **Profiler** — ce que chaque appel consomme vraiment : contexte, outils, mémoire, débit.

## 🎨 Une quarantaine d'apps, chacune dans sa fenêtre

Chaque app est un paquet que vous installez, mettez à jour ou retirez depuis le Catalogue, et qui s'ouvre dans sa propre fenêtre — plusieurs à la fois si vous voulez.

- **Créer** — Notes, Carte mentale, Planche, Canevas créatif, Photos, Studio d'images
- **Organiser** — Agenda (avec prompts IA), Tableau kanban, Tâches planifiées, Budget
- **Explorer** — Corpus (documents indexés), Enquête (rapports sourcés), Bases de données, Analyse de données, Atelier ML (scikit-learn), Navigateur
- **Son & voix** — Podcast IA, Voix, Studio musical
- **Labo** — Éditeur de code, Python, Domotique
- **Jouer** — Jeux, Aventure générée, Compagnon, Village
- **Intégrées** — Opus & Calc (documents, présentations, tableur), Designer Fluxo, Automatisations, Équipe d'agents, Fil, Traces LLM, Profiler, Mémoire, Clés, Stockage, Réglages

**Génération d'images** — PrismML **Bonsai Image** tourne en local (Apple Silicon, GPU NVIDIA) et se télécharge à la demande ; Apple Image Playground sur macOS 27 ; Ollama et les API compatibles OpenAI derrière la même interface.

### Édition Pro (en préparation)

Un seul binaire : les fonctions Pro se débloquent avec une clé de licence hors ligne. **Relia** (CRM assisté par l'IA, devis et factures Factur-X), **Réunion** (visio et chat d'équipe sur le LAN avec compte rendu IA), **DB Studio**, **Flux de données** (ETL visuel), **Reporting**, **Sources de données**, **Annuaire** et **Messagerie d'équipe** chiffrée de bout en bout — plus un **Lumen Server** optionnel avec rôles, permissions et source d'IA partagée.

## 🔌 Matériel

- **Lumen Controller** — un compagnon physique sur votre réseau local : des boutons associés à des workflows, des agents ou des prompts, et un potentiomètre qui règle le volume système.
- **Support RFID** — passez un badge pour lancer un workflow, réveiller un agent, ou changer de profil et déverrouiller votre session sans mot de passe.
- **Firmwares ESP32** — générez, flashez et pilotez des firmwares MicroPython (capteurs, matrices LED, relais, servos) et un avatar-orbe physique sur écran rond.

## 🍓 Lumen Pi

Un build dédié Raspberry Pi : blocs Fluxo **GPIO** (pigpiod) pour piloter du matériel, voix locales, barre flottante et mode plein écran — un assistant vocal et domotique 100 % local sur un Pi. **LiteRT avec Gemma 4 E2B** apporte une inférence locale allégée sur une carte sans GPU.

<p align="center"><img src="assets/divider.svg" alt="" width="700"></p>

## Télécharger

➡️ **[Dernière version — page de téléchargement](https://github.com/Oneil974/lumen-assistant/releases/latest)**

| Plateforme | Fichier |
|---|---|
| macOS (Apple Silicon) | `.dmg` |
| Windows | `.exe` (installeur) ou `.msi` |
| Linux (Debian/Ubuntu, x86_64) | `.deb` ou `.AppImage` |
| Raspberry Pi / arm64 | `.deb` ou `.AppImage` |

## Prérequis & installation

**Rien à installer** : téléchargez, ouvrez, choisissez un modèle. La pile IA est livrée dans l'application :

- **Inférence** — le moteur llama.cpp est embarqué ; le modèle choisi dans l'assistant de premier démarrage (ou le Catalogue) est téléchargé par Lumen lui-même. Sur Raspberry Pi, LiteRT avec Gemma 4 E2B joue le même rôle sur une carte sans GPU.
- **Voix** — Piper est livré dans l'app sous Linux, Windows et Raspberry Pi ; macOS utilise les voix du système. Les voix se téléchargent depuis le Catalogue, et l'assistant de premier démarrage propose d'en choisir une.
- **Images** — Bonsai Image et ses modèles se téléchargent à la demande depuis le Catalogue.
- **Dictée** — native sur macOS et Windows.

Lumen se met à jour tout seul : les versions sont signées et l'application vérifie une fois par jour s'il en existe une nouvelle (`.dmg` et `.deb` sont des formats de premier téléchargement ; la mise à jour automatique s'applique aux installations `.app`, `-setup.exe`/`.msi` et `.AppImage`).

**Compléments optionnels** — seulement si vous en voulez :

| Quoi | Où | Comment |
|---|---|---|
| **Ollama** comme moteur alternatif | toutes plateformes | installez-le depuis [ollama.com](https://ollama.com) ; Lumen le détecte et liste ses modèles |
| Voix **Kokoro** (meilleure qualité, plus lentes) | Linux, Raspberry Pi | `scripts/setup-linux.sh` ou `scripts/setup-pi.sh` |
| Dictée locale **whisper.cpp** | Linux, Raspberry Pi | mêmes scripts |

Détails : **[scripts/README.md](scripts/README.md)**.

## Confidentialité

En mode local, **aucune donnée ne quitte votre machine** : modèle, inférence, mémoire, documents et bases restent sur votre disque. La recherche web et le mode API cloud sont optionnels et désactivés par défaut ; la clé API, quand il y en a une, ne quitte jamais le backend.

<p align="center"><img src="assets/divider.svg" alt="" width="700"></p>

Ce dépôt héberge la page de présentation et les binaires de l'application (via *Releases*). Le code source n'est pas publié ici.
