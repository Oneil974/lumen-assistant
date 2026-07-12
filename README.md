# Lumen

<p align="center">
  <img src="assets/Lumen_Header.png" alt="Lumen — assistant IA de bureau local-first" width="700">
</p>

**Un assistant IA de bureau local-first — une barre de chat vivante, privée et agentique.**

Lumen tourne en local via [Ollama](https://ollama.com) (le modèle, l'inférence et les données restent sur votre machine), peut utiliser les modèles d'Apple, ou se connecter à une API compatible OpenAI quand un modèle cloud est plus adapté. Au-delà du chat : un bureau complet (Lumen OS) avec fenêtres, widgets, 30+ apps, agents autonomes, workflows visuels Fluxo, mémoire cognitive et connaissances (RAG).

Plateformes : **macOS · Windows · Linux · Raspberry Pi**.

## Télécharger

➡️ **[Dernière version — page de téléchargement](https://github.com/Oneil974/lumen-app/releases/latest)**

| Plateforme | Fichier |
|---|---|
| macOS (Apple Silicon) | `.dmg` |
| Windows | `.exe` (installeur) |
| Linux (Debian/Ubuntu) | `.deb` |
| Raspberry Pi (arm64) | `.deb` |

## Prérequis & installation

Pour l'inférence 100 % locale, Lumen a besoin d'**[Ollama](https://ollama.com)**. Des scripts « tout-en-un » installent Ollama + un modèle, et (sous Linux/Pi) les voix locales **Piper** & **Kokoro** et la dictée **whisper.cpp** :

| Système | Commande (dans `scripts/`) |
|---|---|
| macOS | `./setup-macos.sh` |
| Linux (Debian/Ubuntu) | `./setup-linux.sh` |
| Raspberry Pi OS | `./setup-pi.sh` |
| Windows | `powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1` |

Détails, options et installation séparée des voix : **[scripts/README.md](scripts/README.md)**.

## Site

Page de présentation : **https://Oneil974.github.io/lumen-app/**

## Confidentialité

En mode local (Ollama), aucune donnée ne quitte votre machine. Le mode API cloud est optionnel et entièrement désactivable.

---

Ce dépôt héberge la page de présentation et les binaires de l'application (via *Releases*). Le code source n'est pas publié ici.
