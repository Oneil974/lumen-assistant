# Publier une version

Lumen se met à jour tout seul. Pour que ça reste vrai, chaque release doit
porter des **artefacts signés** et un **manifeste `latest.json`** — c'est ce
fichier que les installations déjà déployées interrogent.

Le dépôt public [`Oneil974/lumen-assistant`](https://github.com/Oneil974/lumen-assistant)
ne contient que le site et les binaires : les builds se font ici, sur les
machines de développement, puis sont déposés là-bas.

---

## Construire les trois produits

```bash
npm run build:all                    # Lumen, Lumen Pro et Lumen Server
./scripts/build-all.sh pro server    # seulement ces deux-là
./scripts/build-all.sh --dry-run     # ce qui serait lancé, sans rien compiler
```

Le script n'invente aucune procédure : il **appelle** celles qui existent
(`build-macos.sh`, `build-linux.sh`, `cargo` dans `lumen-server/`) et rassemble
les livrables dans `dist/`. Une chaîne parallèle finirait par diverger de celle
qu'on utilise à la main.

| Produit | Ce qui sort |
|---|---|
| Lumen | `.dmg` (macOS) · `.deb` + `.AppImage` (Linux) |
| Lumen Pro | idem, sous le nom « Lumen Pro » — bundle et icône distincts |
| Lumen Server | `dist/lumen-server-<version>-<plateforme>.tar.gz`, démon + `llama-server` llama.cpp + bibliothèques |

Lumen et Lumen Pro **partagent `target/`** : la seconde compilation ne refait
que ce que la feature `pro` change. Le bundler DMG vidant `bundle/dmg` à chaque
passage, les images sont recopiées dans `dist/`, où les deux éditions cohabitent.

Pour Lumen Server, le script compile llama.cpp pour la cible native (Metal sur
Apple Silicon, CPU par défaut sur Linux), resynchronise le catalogue, puis
fabrique une archive autonome. `lumen-serverd` et son propre `llama-server`
sont côte à côte : décompresser l'archive suffit pour démarrer le serveur
d'inférence local.

Sur macOS 27, `build-macos.sh` compile aussi la **passerelle Apple Foundation
Models** (`npm run build:applefm`, sortie dans `src-tauri/resources/applefm/`).
Sans SDK 27, elle est simplement omise et la source n'apparaît pas dans l'app.
Private Cloud Compute ne fonctionne qu'avec l'entitlement
`com.apple.developer.private-cloud-compute`, à demander à Apple puis à poser dans
les entitlements du bundle : sans lui, la passerelle n'annonce que le modèle sur
l'appareil.

Le script **ne signe rien** : exportez `TAURI_SIGNING_PRIVATE_KEY` avant si vous
préparez une release, sinon aucun fichier `.sig` n'est produit et
`scripts/release.mjs` refusera de publier. Il le rappelle au démarrage.

Un produit qui échoue arrête la série ; `--keep-going` la poursuit, ce qui vaut
mieux quand on lance les trois avant de partir déjeuner.

---

## Une seule fois, pour toujours

```bash
npm run setup:updater
```

Génère la paire de clés de signature, inscrit la **clé publique** dans
`src-tauri/tauri.conf.json` (à committer) et écrit la **clé privée** dans
`~/.lumen/updater.key` (à ne jamais committer).

> ⚠️ Cette clé est définitive. Si elle est perdue ou régénérée, **toutes les
> installations existantes cessent de pouvoir se mettre à jour** et devront
> être réinstallées à la main. Sauvegardez `~/.lumen/updater.key` ailleurs que
> sur la machine de build.

---

## Signature macOS : deux signatures, à ne pas confondre

Il y a **deux** signatures dans une release macOS, et elles ne servent pas à la
même chose :

| | À quoi ça sert | Sans elle |
|---|---|---|
| Clé updater (`setup:updater`) | Prouver qu'une mise à jour vient bien de vous | L'updater refuse le paquet |
| Signature de code Apple | Donner une **identité stable** à l'app auprès de macOS | Gatekeeper bloque, et **toutes les autorisations sautent à chaque build** |

Sans certificat Apple, `tauri build` pose une signature *ad-hoc* : l'exigence
désignée du bundle devient `cdhash H"…"`, c'est-à-dire « cette app EST ce hash
de binaire ». Chaque recompilation change le hash, donc change l'app aux yeux du
système. Conséquence directe : **Enregistrement de l'écran, Micro,
Accessibilité — tout est révoqué à chaque build**, alors que l'entrée reste
affichée et cochée dans les Réglages Système. C'est exactement le symptôme
« il redemande l'autorisation alors qu'elle est déjà activée ».

Pour les utilisateurs, c'est pire : chaque mise à jour livrée par l'updater
change le hash, donc leur redemande toutes les autorisations.

**Pour les builds locaux**, un certificat auto-signé suffit à rendre l'identité
stable :

```bash
bash scripts/setup-macos-signing.sh
APPLE_SIGNING_IDENTITY="Lumen Local Dev" npm run tauri build
```

**Pour la distribution**, il faut un certificat *Developer ID Application*
(compte Apple Developer, 99 $/an), le *hardened runtime* et la notarisation :

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: … (TEAMID)"
export APPLE_ID="…" APPLE_PASSWORD="…" APPLE_TEAM_ID="…"   # notarisation
npm run tauri build
```

Vérifier, dans les deux cas, que l'identité ne dépend plus du binaire :

```bash
codesign -d -r- /chemin/Lumen.app
# attendu : identifier "com.lumen.app" and certificate leaf = H"…"
# à proscrire : cdhash H"…"
```

Après un changement de signature, purger une fois l'autorisation périmée :

```bash
tccutil reset ScreenCapture com.lumen.app
```

puis retirer l'entrée « Lumen » résiduelle dans Réglages Système →
Confidentialité et sécurité → Enregistrement de l'écran (bouton « − ») avant de
relancer l'application.

---

## À chaque version

**1. Numéroter.** Le numéro qui fait foi est celui de
`src-tauri/tauri.conf.json` (`version`). Alignez `src-tauri/Cargo.toml` et
`package.json` dessus. L'updater compare `version` à celle de l'app installée :
sans incrément, aucune mise à jour n'est proposée.

**2. Construire, signé, sur chaque plateforme cible.** La signature n'a lieu
que si la clé est présente dans l'environnement :

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.lumen/updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
npm run tauri build
```

Les formats installables par l'updater sont `.app.tar.gz` (macOS),
`.AppImage` (Linux) et `-setup.exe` (Windows). Un `.dmg` ou un `.deb` reste
utile au **premier** téléchargement mais n'est pas une cible de mise à jour.

Les artefacts des autres plateformes doivent être copiés dans
`src-tauri/target/release/bundle/` avant l'étape suivante, avec leur `.sig`.

**3. Assembler le manifeste.**

```bash
npm run release
```

Rassemble tout dans `dist/release/` et compose `latest.json` : version, notes
(reprises de `CHANGELOG.md` si la section existe), et pour chaque plateforme
son URL de téléchargement et sa signature.

**4. Vérifier avant de publier.** Ouvrez `dist/release/latest.json` et
contrôlez que toutes les plateformes visées y sont. Une plateforme absente =
ses utilisateurs ne verront jamais la mise à jour, silencieusement.

**5. Publier.**

```bash
npm run release -- --publish
```

Crée la release `v<version>` sur le dépôt public via `gh` et y téléverse
`latest.json` et les artefacts.

---

## Vérifier que ça marche

Sur une machine avec la version **précédente** installée :
**Réglages → Sauvegarde et mises à jour → Rechercher une mise à jour**.

La nouvelle version doit apparaître avec ses notes. Si rien ne se passe, dans
l'ordre :

| Symptôme | Cause la plus probable |
|---|---|
| « Signature invalide » | Build fait sans `TAURI_SIGNING_PRIVATE_KEY`, ou clé différente de la `pubkey` du config |
| Aucune mise à jour proposée | `version` non incrémentée, ou plateforme absente de `latest.json` |
| Erreur réseau / 404 | La release n'est pas publiée, ou `latest.json` n'y est pas attaché |
| « pubkey vide » | `npm run setup:updater` n'a jamais été lancé |

L'app vérifie ensuite d'elle-même une fois par jour et dépose l'annonce dans la
**boîte de réception** — jamais en fenêtre modale.
