# Lumen

<p align="center">
  <img src="assets/Lumen_Header.png" alt="Lumen — assistant IA de bureau local-first" width="700">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/statut-b%C3%AAta-ff9e6b" alt="Statut : bêta">
  <a href="https://github.com/Oneil974/lumen-app/releases/latest"><img src="https://img.shields.io/github/v/release/Oneil974/lumen-app?label=version&color=9961ff" alt="Dernière version"></a>
  <img src="https://img.shields.io/badge/plateformes-macOS%20·%20Windows%20·%20Linux%20·%20Raspberry%20Pi-47a3ff" alt="Plateformes">
  <img src="https://img.shields.io/badge/IA-100%25%20locale%20possible-61f2c7" alt="Local-first">
  <img src="https://img.shields.io/badge/donn%C3%A9es-sur%20votre%20machine-ff54a3" alt="Données privées">
</p>

<p align="center"><img src="assets/divider.svg" alt="" width="700"></p>

**Un assistant IA de bureau local-first — une barre de chat vivante, privée et agentique, qui grandit jusqu'à devenir un bureau complet.**

Lumen embarque désormais son propre moteur d'inférence : **rien à installer** pour commencer à parler à un modèle local. Il sait aussi utiliser [Ollama](https://ollama.com), les modèles d'Apple, ou une API compatible OpenAI quand un modèle cloud est plus adapté — chaque source gardant son propre modèle.

➡️ **[Télécharger la dernière version](https://github.com/Oneil974/lumen-app/releases/latest)** · 🌐 **[Site de présentation](https://Oneil974.github.io/lumen-app/)** · 📝 **[Journal des versions](https://Oneil974.github.io/lumen-app/changelog.html)**

> [!NOTE]
> **Lumen est en bêta, en développement actif.** Les fonctionnalités évoluent vite d'une version à l'autre et des bugs peuvent subsister. Vos retours sont bienvenus via les [issues](https://github.com/Oneil974/lumen-app/issues).

---

## ✨ Une barre vivante

Une capsule de chat flottante, toujours à portée de main, avec un **orbe animé** qui respire, écoute et réagit.

- **Quatre moteurs** — llama.cpp embarqué (rien à installer), Ollama local, modèles Apple, ou API compatible OpenAI. On change de source en un clic, chacune retrouvant son modèle.
- **Orbe ou avatar** — l'orbe de verre WebGL, ou votre propre modèle **GLB animé** dont les animations suivent les états de l'assistant.
- **Modes de discussion** — chat direct, **Documents** (vos fichiers indexés), routeur d'actions, tool calling, ou un workflow précis.
- **Comprendre cet écran** — Lumen capture l'écran réel et le fait décrire par le modèle vision actif.
- **Voix & dictée** — **Piper est livré dans l'application** (Linux, Windows), plus Kokoro, les voix système et la dictée whisper.cpp. 100 % hors-ligne possible.
- **Mémoire** — huit types de souvenirs, rappel avant de répondre, politique d'accès cloisonnée appliquée côté backend.
- **Notifications audio & visuelles** — chaque type d'événement a son son et son signal sur l'orbe.
- **Compagnon iPhone & Telegram** — la session en miroir sur votre téléphone, ou l'assistant joignable depuis Telegram sans ouvrir un seul port.

## 🖥️ Lumen OS — le bureau immersif

Un environnement de travail complet dans une fenêtre : session multi-profils, fenêtres, widgets, Spotlight (⌘K), centre de notifications, thèmes clair/sombre.

<p align="center">
  <img src="assets/Lumen_Desktop_Pi.png" alt="Lumen OS — launcher d'applications, Designer Fluxo (GPIO) et Assistant IA, ici sur Raspberry Pi" width="700">
  <br>
  <sub><em>Lumen OS tournant sur un Raspberry Pi : launcher, Designer Fluxo (blocs GPIO) et Assistant IA en local.</em></sub>
</p>

- **Nouvelle barre d'icônes & launcher** — une barre compacte qui s'efface, un launcher plein écran, et un menu d'apps que vous rangez vous-même.
- **Sandbox IA** — des espaces fichiers isolés où les agents lisent, écrivent et exécutent sans toucher au reste de la machine.
- **Corpus (RAG)** — indexez vos documents, interrogez-les en langage naturel, et voyez les passages sur lesquels repose chaque réponse, avec leur score.
- **Bases de données** — tables SQLite façon Baserow, requêtes en langage naturel (lecture seule), intégrées aux autres apps.
- **Mode consultation** *(alpha)* — une interface apaisée, pensée pour le tactile, sur écran partagé ou tablette.
- **Forge** — décrivez une app, Lumen la génère, vous la codez — sans changer de fenêtre.

## 🤖 Agents, Fluxo & Skills

- **Orchestrateur & sous-agents** — un agent principal découpe une demande et délègue à des spécialistes, avec budgets de tokens et d'itérations, et escalade au lieu de boucler.
- **Mode Automation** — une version à base de nœuds de Fluxo pour les automatisations planifiées et déclenchées par événement, avec leur historique d'exécution.
- **Designer Fluxo** — éditeur visuel de workflows : déclencheurs, actions système, blocs IA, notifications.
- **Connecteurs MCP** — les serveurs Model Context Protocol se branchent en un clic (distants officiels, HTTPS avec jeton en en-tête).
- **Boîte à outils** — vous choisissez les outils publiés au modèle, un par un : un outil inutile coûte du contexte avant même votre question.
- **Recherche web activable** — désactivée par défaut ; rien ne part en ligne tant que vous ne l'allumez pas.
- **Profiler** — ce que chaque appel consomme vraiment : contexte, outils, mémoire, débit.

## 🎨 Une trentaine d'apps, regroupées en hubs

**Corpus** (documents indexés, enquêtes sourcées) · **Prisme** (tables, analyse, modèles ML) · **Muse** (notes, cartes mentales, planches, canvas génératif) · **Opus & Calc** (documents, présentations, tableur) · **Tempo** (tâches, kanban, agenda) · **Écho** (podcast IA, studio de voix) · **Forge** (studio d'apps, éditeur de code) · **Arcade** (jeux, aventure générée, compagnon) · plus Navigateur, Finance, Studio d'images, Studio musical, Domotique et Mémoire.

## 🔌 Matériel

- **Lumen Controller** — un compagnon physique sur votre réseau local : des boutons associés à des workflows, des agents ou des prompts, et un potentiomètre qui règle le volume système.
- **Support RFID** — passez un badge pour lancer un workflow, réveiller un agent, ou changer de profil et déverrouiller votre session sans mot de passe.
- **Firmwares ESP32** — générez, flashez et pilotez des firmwares MicroPython (capteurs, matrices LED, relais, servos) et un avatar-orbe physique sur écran rond.

## 🍓 Lumen Pi

Un build dédié Raspberry Pi : blocs Fluxo **GPIO** (pigpiod) pour piloter du matériel, voix locales, barre flottante et mode plein écran — un assistant vocal et domotique 100 % local sur un Pi.

<p align="center"><img src="assets/divider.svg" alt="" width="700"></p>

## Télécharger

➡️ **[Dernière version — page de téléchargement](https://github.com/Oneil974/lumen-app/releases/latest)**

| Plateforme | Fichier |
|---|---|
| macOS (Apple Silicon) | `.dmg` |
| Windows | `.exe` (installeur) ou `.msi` |
| Linux (Debian/Ubuntu, x86_64) | `.deb` ou `.AppImage` |
| Raspberry Pi / arm64 | `.deb` ou `.AppImage` |

## Prérequis & installation

**Aucun prérequis pour démarrer** : le moteur llama.cpp est embarqué, et Lumen télécharge lui-même le modèle choisi à la première ouverture.

Les scripts « tout-en-un » restent là pour qui préfère **Ollama** comme moteur, et (sous Linux/Pi) pour les voix **Kokoro** et la dictée **whisper.cpp** :

| Système | Commande (dans `scripts/`) |
|---|---|
| macOS | `./setup-macos.sh` |
| Linux (Debian/Ubuntu) | `./setup-linux.sh` |
| Raspberry Pi OS | `./setup-pi.sh` |
| Windows | `powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1` |

Détails, options et installation séparée des voix : **[scripts/README.md](scripts/README.md)**.

## Confidentialité

En mode local, **aucune donnée ne quitte votre machine** : modèle, inférence, mémoire, documents et bases restent sur votre disque. La recherche web et le mode API cloud sont optionnels et désactivés par défaut ; la clé API, quand il y en a une, ne quitte jamais le backend.

<p align="center"><img src="assets/divider.svg" alt="" width="700"></p>

Ce dépôt héberge la page de présentation et les binaires de l'application (via *Releases*). Le code source n'est pas publié ici.
