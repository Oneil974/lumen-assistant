# Moteur vocal Piper embarqué

Ce dossier est rempli par `scripts/piper/fetch-bundle.sh` avant `tauri build` :

    ./scripts/piper/fetch-bundle.sh          # la plateforme courante
    ./scripts/piper/fetch-bundle.sh --all    # toutes les cibles (machine de build)

Arborescence attendue, une par cible (`src-tauri/src/tts.rs` → `piper_bundle_target`) :

    piper/linux-x64/piper      + ses .so et espeak-ng-data
    piper/linux-arm64/piper
    piper/linux-armv7/piper
    piper/windows-x64/piper.exe

**macOS n'a pas de dossier ici** : les archives officielles annoncées pour macOS
contiennent un binaire x86_64 et n'embarquent pas leurs dylibs, elles ne
s'exécutent pas. Sur macOS, Lumen installe le runtime `piper-tts` à la demande,
en un clic depuis Paramètres → Dictée et voix (commande `tts_install_runtime`).

Le dossier est conservé (avec ce fichier) même vide : il est déclaré dans
`bundle.resources` de `tauri.conf.json`, qui exige un chemin existant.
