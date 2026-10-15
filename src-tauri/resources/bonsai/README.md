# Moteur Bonsai Image (PrismML) — copie de développement

Le moteur n'est PAS embarqué dans l'app (il n'est plus dans `bundle.resources`) :
Lumen le télécharge à la demande depuis la Release GitHub « bonsai-engine » de
Oneil974/lumen-app, décrite par `https://oneil974.github.io/lumen-apps/bonsai-engine.json`,
vers `<données>/bonsai/engine/<cible>/`. Voir Catalogue → Modèles → Image.

`npm run build:bonsai` (`scripts/build-bonsai-engine.sh` / `.ps1`) produit
l'archive `dist/bonsai-engine/lumen-bonsai-engine-<cible>-<version>.zip`, met à
jour le manifeste, et dépose ici une copie `<cible>/` que `engine_dir()`
(src-tauri/src/bonsai.rs) trouve en build debug — pratique pour tester sans
télécharger. `npm run bonsai:publish` envoie l'archive et le manifeste.

Contenu d'une cible : `python/` (CPython autonome + mflux, fork MLX PrismML,
prism-image-studio… ; PyTorch remplacé par `src-tauri/bonsai/torch_stub.py`,
OpenCV/matplotlib retirés : ~390 Mo dézippé, ~120 Mo en archive),
`lumen_bonsai_server.py`, `lumen-bonsai`, `VERSION`.
