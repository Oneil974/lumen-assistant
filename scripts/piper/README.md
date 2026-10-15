# Piper multiplateforme pour Lumen

Sur Linux et Windows, Lumen utilise la release historique `2023.11.14-2` de
[`rhasspy/piper`](https://github.com/rhasspy/piper/releases/tag/2023.11.14-2),
dont le code Piper est sous licence MIT. Les dépendances embarquées,
notamment espeak-ng, conservent leurs propres licences. Sur macOS, les archives historiques sont
incomplètes et l'archive dite ARM64 contient en réalité un binaire Intel. Le
script installe donc `piper-tts` maintenu dans un environnement Python isolé ;
ce runtime est sous GPL-3.0.

## Installation du moteur seul

### macOS (Apple Silicon ou Intel)

```bash
./scripts/piper/install.sh
```

Le moteur est installé dans
`~/Library/Application Support/com.lumen.app/piper-runtime`. Aucun `sudo`
n'est nécessaire. Lumen recherche directement cet emplacement même lorsqu'il
est lancé depuis Finder.

### Linux et Raspberry Pi

```bash
sudo ./scripts/piper/install.sh
```

Architectures prises en charge : x86_64, arm64/aarch64 et armv7.
`paplay`, `aplay` ou `pw-play` reste nécessaire pour la lecture.

### Windows 10/11 x64

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\piper\install-windows.ps1
```

Le moteur est installé par défaut dans
`%LOCALAPPDATA%\Lumen\Piper` et ajouté au `PATH` de l'utilisateur. Redémarrez
Lumen après l'installation.

## Installation complète Lumen

Les installateurs tout-en-un proposent aussi de télécharger les voix françaises
et anglaises par défaut dans le dossier de données de Lumen :

```bash
./scripts/setup-macos.sh
./scripts/setup-linux.sh
./scripts/setup-pi.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

Les modèles de voix ont leur propre licence, affichée dans le catalogue de voix
de Lumen ; la licence MIT ci-dessus concerne le code du moteur Piper historique,
pas l’ensemble des bibliothèques de ses archives.
