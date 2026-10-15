# Passerelle Image Playground (Apple Intelligence)

Exécutable `lumen-imageplayground` (source : `src-tauri/imageplayground/main.swift`),
produit par `npm run build:imageplayground` dans `<cible>/` (`macos-arm64`,
`macos-x64`). Sur macOS 27 l'API programmatique `ImageCreator` a disparu : la
passerelle présente la feuille système `ImagePlaygroundViewController` avec le
prompt de Lumen et renvoie l'image validée en PNG ; `src-tauri/src/imageplayground.rs`
la lance à chaque génération (moteur d'image « playground »).

Le dossier est embarqué tel quel par `tauri.conf.json` (`bundle.resources`).
Sans SDK macOS 27, ou sur Linux/Windows, il reste vide et le moteur
« Image Playground » n'apparaît pas dans Lumen.
