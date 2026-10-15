# Composants tiers et choix de licence

État de l'inventaire : 15 octobre 2026. Le choix du code original de Lumen est
**GPL-3.0-or-later**, pour conserver libres les versions dérivées distribuées.
Le texte complet figure dans [COPYING](COPYING). La GPL ne remplace pas les
licences propres aux composants et contenus tiers.

## Dépendances de l'application de bureau

Le lockfile npm contient **185 paquets**, outils et variantes de plateforme
compris. L'inventaire Cargo du bureau couvre **765 paquets** après correction
de sécurité, y compris les cibles non actives. Ces chiffres ne correspondent
pas au nombre de bibliothèques effectivement chargées par l'application.

| Composant direct ou embarqué | Licence identifiée | Mentions |
| --- | --- | --- |
| Three.js | MIT | Copie dans `src/lib/`, paquet npm et notices collectées |
| ECharts | Apache-2.0 | Paquet npm et notices collectées |
| ExcelJS, pdf-lib, fflate, KaTeX | MIT | Bundles dans `src/lib/vendor/`, notices dans `src/legal/npm/` |
| PDF.js | Apache-2.0 | `src/lib/vendor/pdfjs/LICENSE` |
| MapLibre GL | BSD-3-Clause | `src/lib/vendor/maplibre/LICENSE.txt` |
| Tauri et nombreux crates Rust | MIT OU Apache-2.0 | `src/legal/rust/inventory.json` et textes adjacents |
| Crates MPL-2.0 | MPL-2.0 | Conserver leurs licences et l'accès aux sources des fichiers couverts |
| Fluxo engine | MIT déclaré par son manifeste | `src-tauri/crates/fluxo-engine/Cargo.toml` ; origine à conserver |
| object, adaptation locale | MIT OU Apache-2.0 | Licences et `LUMEN-PATCH.md` dans `src-tauri/crates/object/` |
| Blockly | Apache-2.0 | `src/robotstudio/vendor/NOTICE.txt` |
| Rpi-Robot-Studio | MIT | Mention d'origine dans le même fichier |
| Pyodide / Python | MPL-2.0 / licence Python et composants associés | Textes dans `src/python/vendor/pyodide/` ; conserver les notices de la distribution |
| Lucide et autres icônes | Selon le jeu | `src/lib/ICONS-LICENSE.txt` |
| Robot heads | MIT | `src/lib/robot-heads/LICENSE` |
| Kenney, KayKit | CC0 selon les mentions jointes | `src/lib/avatars/kenney/LICENSE.txt`, `src/lib/xr-assets/kaykit/LICENSE.txt` |

L'analyse des expressions déclarées permet le choix GPLv3 : les alternatives
MIT/Apache sont utilisables sans choisir les branches GPL/LGPL des licences
multiples. Apache-2.0 est compatible avec GPLv3, contrairement à GPLv2 seule.
MPL-2.0 prévoit la combinaison avec une licence secondaire sous ses conditions.
Sources : [GNU](https://www.gnu.org/licenses/license-list.html.en),
[Apache](https://www.apache.org/licenses/GPL-compatibility),
[Mozilla](https://www.mozilla.org/en-US/MPL/2.0/combining-mpl-and-gpl/).

## Moteurs, modèles et voix

- **llama.cpp / whisper.cpp** : MIT ; les scripts doivent conserver les textes
  avec les binaires produits. Les modèles GGUF et modèles de dictée gardent
  leurs propres conditions.
- **Piper historique** : projet MIT, mais une archive peut contenir des
  bibliothèques additionnelles, notamment espeak-ng sous GPL. Ne pas étiqueter
  l'archive entière « MIT » sans vérifier son contenu et les sources requises.
- **Piper actuel installé à la demande sur macOS** : GPL-3.0 selon
  [scripts/piper/README.md](scripts/piper/README.md). Les voix ont leurs licences propres.
- **Bonsai / mflux / runtimes Python, LiteRT, Kokoro** : distributions
  optionnelles à inventorier par archive et par version avant redistribution.
  Elles ne sont pas recopiées dans le miroir source ; le choix GPL de Lumen
  ne vaut pas autorisation sur leurs modèles, poids ou dépendances natives.
- **SDK Apple et services distants** : conditions de leurs éditeurs,
  distinctes de la GPL de Lumen.

## Ressources graphiques exclues du miroir public

Les packs Gaming Room Interiors, Minimalist Interiors (Gaming/Cosy découpés)
et MetroCity n'ont pas de preuve locale suffisante de redistribution des
fichiers source. Ils restent dans le poste de travail mais sont filtrés par
l'export ; le manifeste des décors devient vide. Une licence permettant
l'intégration dans un jeu ne suffit pas automatiquement à republier les PNG
dans un dépôt de sources. Réintégrer uniquement après vérification explicite
ou remplacer ces ressources.

## Collecte et limites de vérification

```bash
npm ci
npm run licenses:collect
python3 scripts/collect-rust-licenses.py
```

Le premier script collecte les textes des paquets npm installés sur la
plateforme courante (140 sur le poste macOS de cet inventaire ; variantes
optionnelles absentes omises). Le second utilise `cargo metadata --locked
--offline` et nécessite que les dépendances aient été récupérées. Les
inventaires ne contiennent pas de chemins privés du poste. Les textes collectés
dans `src/legal/` sont inclus dans le noyau livré.

**Points à résoudre avant d'affirmer que toutes les redistributions sont
couvertes :** `buffers@0.1.1` ne déclare pas sa licence dans l'archive npm et
n'y joint pas de texte autonome ; plusieurs autres archives ne joignent pas
non plus de fichier de licence racine, malgré une expression déclarée.
Les inventaires signalent ces cas sans leur inventer une licence. L'absence
d'un fichier racine ne prouve pas l'absence de toute mention dans le code.
La collecte ne remplace pas la revue de ces cas ni l'inventaire des dépendances
des compagnons, du serveur autonome et des archives natives optionnelles.

Pour une release binaire GPL, fournir le code source correspondant exact,
les scripts et modifications nécessaires au build et les mentions tierces,
pas uniquement un lien vers une branche qui évolue. Cette préparation de
sources n'est pas une certification de conformité de toutes les archives.

## Modèles GGUF optionnels : décision et OCR

Les poids ne sont pas embarqués dans les sources. Le Catalogue et Études proposent des téléchargements utilisateur indépendants :

| Modèle | Dépôt GGUF | Licence des poids |
| --- | --- | --- |
| Kev 0.8B / 4B / 9B | [ggml-org](https://huggingface.co/ggml-org/Kev-0.8B-GGUF) (dépôts Kev-4B-GGUF et Kev-9B-GGUF associés) | Apache-2.0 |
| GLM-OCR | [ggml-org/GLM-OCR-GGUF](https://huggingface.co/ggml-org/GLM-OCR-GGUF), [modèle d’origine](https://huggingface.co/zai-org/GLM-OCR) | MIT |
| PaddleOCR-VL 1.6 | [PaddlePaddle/PaddleOCR-VL-1.6-GGUF](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF) | Apache-2.0 |

Les projecteurs vision sont téléchargés avec leur modèle OCR. Consulter la fiche et la licence du dépôt avant de redistribuer les poids.
