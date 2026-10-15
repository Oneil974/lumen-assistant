# Lumen 0.2 — noyau, paquets, engine

Jusqu'à la 0.1.x, Lumen était un bloc : une trentaine d'applications compilées
dans le même binaire, un menu démarrer écrit en dur, et une édition « Pro »
obtenue en recompilant tout avec un drapeau. Ajouter une application voulait dire
toucher au shell ; retirer celles qu'on n'utilisait pas était impossible.

La 0.2 sépare trois choses qui étaient mêlées : **ce que Lumen est**, **ce qu'on
y installe**, et **ce qu'une application a le droit de faire**.

## 1. Le noyau

Ce qui reste dans le binaire, parce que le reste s'y adosse :

| App | Pourquoi elle ne peut pas sortir |
|---|---|
| Assistant | C'est Lumen. |
| Fichiers / Sandbox | Le stockage de toutes les autres. |
| Équipage (agents, fil, traces, profiler) | Les agents exécutent les outils des apps. |
| Fluxo | Le moteur d'automatisation, appelé par tout le reste. |
| Mémoire | Politique d'accès partagée. |
| Visite guidée, Raccourcis | Le mode d'emploi du bureau lui-même. |
| Stockage, Paramètres | On doit pouvoir réparer sans rien installer. |
| Catalogue | C'est d'ici qu'on installe. |
| Documentation | Doit fonctionner quand rien d'autre ne fonctionne. |

Opus (documents) et Calc (tableur) y restent **provisoirement** : ce ne sont pas
des pages autonomes mais des fenêtres dessinées par le shell
(`src/sandbox/creative-editor.js`, `src/sandbox/sheets.js`). Les extraire demande
de leur écrire un hôte, pas de zipper un dossier.

## 2. Les paquets

Tout le reste — 42 applications — est un fichier `.lumenapp` : une archive ZIP
avec un `manifest.json` à la racine, téléchargée depuis un dépôt, installée dans
`<données>/apps/<id>/`, désinstallable.

```bash
npm run apps:package                 # fabrique dist/apps/*.lumenapp + index.json
node scripts/repo-sign.mjs --keygen  # une fois : clé de signature du dépôt
npm run apps:sign                    # signe l'index
```

Le contenu d'un paquet est **calculé, pas déclaré** : `scripts/package-apps.mjs`
part du point d'entrée et suit les dépendances (imports, `src`, `href`, `url()`).
Une liste écrite à la main se périme au premier import ajouté, et le symptôme —
une app qui s'ouvre sur un écran blanc — ne dit rien de la cause.

L'arborescence du ZIP **reproduit celle de `src/`**, pour que les chemins
relatifs entre apps (`../lib/ui.css`, `../llm.js`) continuent de résoudre sans
qu'une seule URL soit réécrite.

### Vérification

L'index donne pour chaque paquet une empreinte SHA-256, comparée après
téléchargement. Si le binaire embarque `REPO_PUBLIC_KEY`, l'index doit en plus
être signé. Sans clé configurée, on ne prétend pas vérifier : le Catalogue
affiche « dépôt non signé », ce qui est la vérité.

La signature ne porte pas sur le texte JSON — Node et Rust n'ordonnent ni
n'échappent les clés de la même façon — mais sur une forme canonique
`id|version|sha256` triée. Une URL réécrite ne sert à rien à un attaquant : le
paquet servi devra malgré tout correspondre à l'empreinte signée.

## 3. L'engine et les deux niveaux de confiance

Une app installée est servie sur **son origine à elle** (`lumenapp://<id>/`,
cf. `src-tauri/src/appserve.rs`). Deux apps ne partagent donc ni stockage, ni
cookies, ni accès au DOM l'une de l'autre : c'est le navigateur qui l'impose.

Deux ponts sont injectés en tête de chaque page HTML servie :

- **`src/lib/appkit/tauri-shim.js`** — rend un `window.__TAURI__` d'apparence
  identique, dont chaque appel part en postMessage vers le bureau ;
- **`src/lib/appkit/guest.js`** — le SDK `window.lumen` : `ai`, `assistant`,
  `tools`, `storage`, `files`, `tables`, `memory`, `interop`, `net`, `notify`,
  `clipboard`, `ui`.

Le bureau (`src/lib/appkit/host.js`) arbitre. C'est là qu'est la frontière :

| | `window.__TAURI__` (commandes brutes) | `window.lumen` (capacités) |
|---|---|---|
| **first-party** (paquets signés Lumen) | relayé | accordé après consentement |
| **third-party** | **refusé** | accordé après consentement |

Les paquets du catalogue officiel sont déclarés `first-party` parce que ce sont
littéralement les mêmes fichiers qui vivaient dans le bundle : leur accorder
moins ne les rendrait pas plus sûrs, ça les casserait. Une application venue
d'ailleurs n'obtient jamais ce niveau.

### Permissions

Le manifeste déclare les capacités demandées ; elles sont affichées sur la carte
du Catalogue **avant** l'installation. Déclarer n'est pas obtenir : à la première
utilisation effective, le bureau pose la question, et la réponse est mémorisée
par `src-tauri/src/appperms.rs` — révocable dans Paramètres → Applications et
licence.

La feuille de consentement est dessinée par l'hôte, jamais par l'app : une app ne
peut pas contrefaire un dialogue système, elle ne peut que le déclencher.

`interop` est la seule capacité paramétrée : `interop:notes` est le droit
d'envoyer à `notes`, pas un droit d'interop général. Le partage passant par le
sélecteur (`lumen.interop.share`) ne demande rien — c'est l'utilisateur qui
choisit la destination à l'instant même.

## 4. La licence Pro

Il n'y a plus deux binaires. La feature Cargo `pro` est compilée par défaut, et
c'est une **clé de licence** qui déverrouille les applications professionnelles.

```bash
node scripts/license-keygen.mjs           # une fois, sur un poste de confiance
node scripts/license-issue.mjs "Client"   # [--days 365]
```

La clé est un message signé Ed25519 : `LUMEN-PRO.<payload>.<signature>`. Le
binaire ne connaît que la clé publique — même désassemblé, il ne permet pas d'en
forger une. La vérification est locale, sans serveur, et fonctionne hors ligne.

Ce n'est pas (et ne peut pas être) une protection contre quelqu'un qui recompile
le logiciel : le code source est là. C'est une barrière honnête.

Une clé émise ne peut pas être révoquée — c'est le prix du hors-ligne. Pour un
abonnement, émettez une clé à durée limitée.

## Écrire une application Lumen

```
mon-app/
  manifest.json     { id, name, version, entry, capabilities, trust: "third-party" }
  index.html
```

```js
await lumen.permissions.request("ai");        // au bon moment, pas au chargement
const résumé = await lumen.ai.ask("Résume : " + texte);
await lumen.storage.set("dernier", résumé);
await lumen.interop.share("note", { title: "Résumé", text: résumé });
```

Les erreurs de permission portent `err.code === "denied"` : une app bien écrite
dégrade (« la synthèse IA est indisponible ») au lieu de planter.
