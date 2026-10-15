# Moteur Bonsai Image (PrismML) — runtime optionnel

Le moteur n’est pas embarqué dans l’application :
Lumen le télécharge à la demande depuis la Release GitHub « bonsai-engine » de
Oneil974/lumen-app, décrite par `https://oneil974.github.io/lumen-apps/bonsai-engine.json`,
vers `<données>/bonsai/engine/<cible>/`. Voir Catalogue → Modèles → Image.

`npm run build:bonsai` (`scripts/build-bonsai-engine.sh` / `.ps1`) produit
l'archive `dist/bonsai-engine/lumen-bonsai-engine-<cible>-<version>.zip`, met à
jour le manifeste, et dépose ici une copie `<cible>/` que `engine_dir()`
(src-tauri/src/bonsai.rs) trouve en build debug — pratique pour tester sans
télécharger. Pour distribuer votre propre runtime, configurez vos dépôts de publication
et le manifeste distant avant d’utiliser `npm run bonsai:publish`.

Contenu d'une cible : `python/` (CPython autonome + mflux, fork MLX PrismML,
prism-image-studio… ; PyTorch remplacé par `src-tauri/bonsai/torch_stub.py`,
OpenCV/matplotlib retirés : ~390 Mo dézippé, ~120 Mo en archive),
`lumen_bonsai_server.py`, `lumen-bonsai`, `VERSION`.
