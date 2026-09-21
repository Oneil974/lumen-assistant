# Scripts d'installation Lumen

**Depuis la version 0.2, rien n'est requis pour utiliser Lumen** : le moteur llama.cpp, les voix Piper (Linux, Windows, Raspberry Pi) et le moteur d'images Bonsai sont livrés avec l'application ou téléchargés par elle depuis le Catalogue. Les scripts de ce dossier n'installent que des **compléments optionnels** : [Ollama](https://ollama.com) comme moteur alternatif, et — sous Linux et Raspberry Pi seulement — les voix **Kokoro** et la dictée locale **whisper.cpp**. Aucun outil de build n'est requis.

## Installation « tout-en-un »

Lancez le script correspondant à votre système, **sans `sudo`** (il demande les droits quand nécessaire). Mode et modèle sont configurables.

### macOS (Apple Silicon)
```bash
./setup-macos.sh          # interactif
./setup-macos.sh --yes    # installe tout sans confirmation
```
Installe **Ollama** + un modèle par défaut, uniquement si vous préférez Ollama au moteur intégré. La voix et la dictée sont gérées nativement par macOS — rien à installer côté voix.

### Linux (Debian/Ubuntu x86_64)
```bash
./setup-linux.sh          # interactif
./setup-linux.sh --yes    # installe tout
```
Installe **Ollama**, les voix **Piper** et **Kokoro**, et la dictée **whisper.cpp**.

### Raspberry Pi OS (64-bit)
```bash
./setup-pi.sh             # interactif
./setup-pi.sh --yes       # installe tout
```
Comme Linux, avec des modèles adaptés au Pi. Sur 4 Go de RAM, privilégiez les petits modèles (ou déportez l'inférence : *Réglages → IA → URL*).

### Windows 10/11 (x64)
```powershell
powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
```
Installe **Ollama** (via winget) + un modèle par défaut, uniquement si vous préférez Ollama au moteur intégré. Les voix Piper sont déjà dans l'application ; la dictée utilise la reconnaissance vocale de Windows.

### Choisir le modèle
```bash
LUMEN_MODEL="qwen2.5:3b" ./setup-linux.sh
```
```powershell
$env:LUMEN_MODEL="qwen2.5:3b"; powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
```

## Composants voix / dictée (Linux & Pi, en autonome)

Les scripts « tout-en-un » les appellent déjà. Pour les (ré)installer séparément, en **root** :

| Composant | Commande | Rôle |
|---|---|---|
| **Piper** | `sudo ./piper/install.sh` | Synthèse vocale rapide (MIT) |
| **Kokoro** | `sudo ./kokoro/install.sh` | Synthèse vocale haute qualité (Apache 2.0, venv dédié) |
| **whisper.cpp** | `sudo ./whisper/install.sh [base\|small\|tiny]` | Dictée locale hors-ligne (MIT) |

> Piper est déjà livré dans l'application : son script ne sert qu'à une installation système séparée. Les **fichiers de voix** (modèles `.onnx`) se téléchargent depuis le **Catalogue** de Lumen.

## Prérequis minimal

Aucun. Le moteur d'inférence est intégré ; Ollama, Kokoro et whisper.cpp sont des compléments. En mode local, aucune donnée ne quitte votre machine.
