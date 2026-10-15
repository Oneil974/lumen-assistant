# Faire parler les apps entre elles

Vingt-huit applications qui partagent un bureau ne font pas un système. Ce qui
fait un système, c'est qu'une chose produite ici puisse être reprise là, sans
export, sans fichier intermédiaire, sans code écrit pour cette paire précise.

C'est le rôle du bus d'interop : [`src/lib/interop.js`](../src/lib/interop.js).

---

## L'objet Lumen

Une seule structure circule. `kind` dit ce que c'est, le reste dépend du
`kind`, `meta` dit d'où ça vient.

```js
{
  kind: "table",                    // text | table | image | link | file | task
  title: "Dépenses de juillet",
  columns: ["Poste", "Montant"],    // propre au kind
  rows: [["Loyer", 900], …],
  meta: { sourceApp: "dataanalysis", sourceTitle: "Analyse", createdAt: 1754… }
}
```

Toujours le construire avec `makeObject(kind, payload, source)` : c'est ce qui
garantit la provenance, et donc la capacité de la cible à afficher « reçu
depuis Analyse ».

---

## Envoyer

```js
import { makeObject } from "../lib/interop.js";
import { share } from "../lib/share-menu.js";

const obj = makeObject("table", { title, columns, rows }, { app: "tables", title: "Bases de données" });
const target = await share(obj);   // "sheets" | "shelf" | null
```

`share()` ouvre le sélecteur, ne propose que les apps qui acceptent ce `kind`,
et se charge de tout le reste. **L'expéditeur ne connaît jamais le
destinataire** — c'est toute l'idée.

---

## Recevoir

Trois lignes, au démarrage de l'app :

```js
import { receive, toText } from "../lib/interop.js";

receive("notes", (obj) => {
  creerNote(obj.title, toText(obj));   // toText convertit une table en Markdown
});
```

`receive()` traite ce qui attendait dans la file **et** reste à l'écoute
pendant que l'app est ouverte. Le récepteur est responsable d'afficher sa
propre fenêtre : le bus ne la rouvre pas par-dessus.

---

## Déclarer une nouvelle cible

Une ligne dans `TARGETS` (`src/lib/interop.js`) :

```js
{ appId: "kanban", label: "Tempo", accepts: ["task", "text"], hint: "Ajouter une carte" },
```

`appId` doit être un identifiant que `window.LumenOpenAppById` sait ouvrir —
c'est-à-dire présent dans `DT_APPS` ou `DT_LEGACY` de
[`src/sandbox/desktop.js`](../src/sandbox/desktop.js).

C'est tout. Aucune modification chez les expéditeurs : la nouvelle cible
apparaît immédiatement dans tous les sélecteurs dont le `kind` correspond.

---

## Les mini-apps confinées

Une app générée dans la sandbox n'a pas accès aux modules de Lumen. Elle passe
par le pont déjà en place :

```js
await window.lumen.share("table", { title: "Résultats", columns, rows });
const parked = await window.lumen.shelf();
```

**Rien ne sort sans que l'utilisateur ait choisi la destination** dans le
sélecteur du bureau. Une mini-app hostile ne peut donc pas écrire ailleurs de
sa propre initiative — c'est pourquoi `lumen_share` n'exige aucune permission,
contrairement aux écritures en base (`window.lumen.tables`).

---

## L'étagère

Le presse-papier universel, pour parquer un objet sans décider tout de suite où
il va : `shelve(obj)`, `readShelf()`, `clearShelf()`. Trente objets maximum,
les plus récents en tête. Les objets légers survivent au redémarrage ; les gros
(images en `data:`) restent en mémoire pour la session plutôt que de faire
exploser le quota de stockage.

---

## Où vit l'état

Les apps sont des iframes **même origine** du bureau : le bus vit sur
`window.top.__lumenBus`. Les objets passent donc **par référence**, sans
sérialisation ni limite de taille — un tableau de dix mille lignes ou une image
en `data:` traversent sans coût.

Corollaire : le bus est vidé à la fermeture de Lumen. C'est délibéré — un relais
n'est pas un stockage. Ce qui doit survivre va dans une app (Notes, Tables,
Corpus), pas dans le bus.

---

## Tests

```bash
node --test scripts/test-interop.mjs
```

Couvre la file d'attente, la livraison à chaud, le désabonnement, la
récupération après échec d'un récepteur, le filtrage des cibles, la conversion
en Markdown et le plafonnement de l'étagère.
