# Passerelle Apple Foundation Models

Exécutable `lumen-applefm` (source : `src-tauri/applefm/main.swift`), produit
par `npm run build:applefm` dans `<cible>/lumen-applefm` (`macos-arm64`,
`macos-x64`). Il expose le framework FoundationModels de macOS 27 en API
OpenAI sur `127.0.0.1:11437` ; `src-tauri/src/applefm.rs` le lance à la demande.

Le dossier est embarqué tel quel par `tauri.conf.json` (`bundle.resources`).
Sur une machine sans SDK macOS 27, ou sur Linux/Windows, il reste vide et la
source « Apple Foundation Models » n'apparaît pas dans Lumen.
