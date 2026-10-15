# Lumen Windows — build desktop x64

Ce build vise Windows x64 en natif. La saveur `windows` est detectee par Rust via
`target_os = "windows"` :

- l'UI masque les options macOS / Shortcuts Apple ;
- les sources Ollama et API cloud restent disponibles ;
- aucune feature Raspberry Pi n'est activee.

## Prerequis

Dans PowerShell :

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-prereqs-windows.ps1
```

Le script utilise `winget` pour installer Visual Studio Build Tools, Rustup et
Node.js LTS. Apres installation, ouvre un nouveau PowerShell.

## Piper local (optionnel)

L'installateur runtime propose la release historique MIT de Piper ainsi que les
voix FR et EN par défaut :

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

Pour installer seulement le moteur Piper :

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\piper\install-windows.ps1
```

Le binaire Windows est disponible uniquement en x64. Il est placé dans
`%LOCALAPPDATA%\Lumen\Piper`; redémarre Lumen après l'installation.

## llama-server : variantes CPU et CUDA

```powershell
node .\scripts\build-llama-server.mjs
```

Le script construit deux binaires dans
`src-tauri\resources\llama-server\windows-x64\` :

- `cpu\llama-server.exe` — toujours construit, fonctionne sur toute machine ;
- `cuda\llama-server.exe` — construit uniquement si `nvcc` est present (CUDA
  Toolkit NVIDIA).

`cmake` est requis dans les deux cas.

Si `nvcc` manque, le script echoue au lieu de continuer : une build sans
variante CUDA produit un Lumen qui tourne sur le processeur en silence, ce qui
ne se remarque qu'a l'usage. `LLAMA_CUDA=0` permet d'assumer explicitement une
version CPU seule.

Les architectures GPU compilees sont demandees a `nvcc --list-gpu-arch` puis
croisees avec celles que Lumen vise (Pascal 61 -> Blackwell 120, dont Ampere 86
pour les RTX 30xx). Elles ne sont pas codees en dur : chaque version majeure du
Toolkit retire les plus anciennes — CUDA 13 a supprime Pascal et Volta — et
`nvcc` refuse alors de compiler quoi que ce soit.

Au demarrage, Lumen choisit la variante selon le reglage « Calcul llama.cpp »
(Reglages -> source llama.cpp). En mode `auto`, CUDA n'est retenu que si le
binaire est embarque **et** qu'une carte NVIDIA repond a `nvidia-smi`. Le statut
sous le reglage indique le backend reellement utilise, et la raison quand il
differe du choix. Avec CUDA, le serveur est lance avec `--n-gpu-layers 999` pour
decharger toutes les couches possibles sur la carte.

## Construire

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
```

Pour demander un bundle precis :

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1 --bundles nsis
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1 --bundles msi
```

Les bundles sont produits dans `src-tauri\target\release\bundle\`.
