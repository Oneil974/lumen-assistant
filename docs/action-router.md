# Contrat du Action Router

Lumen **dispatche** une demande au Action Router (un raccourci macOS « adapté »)
puis affiche en direct la progression que le routeur lui renvoie. Lumen ne fait
que router et recevoir : toute la logique d'exécution vit dans le routeur.

## 1. Entrée — ce que Lumen envoie au raccourci

Lumen lance le raccourci configuré (réglage *Action Router*, défaut
« Action Router ») via `shortcuts run … -i <fichier>`. Le **contenu d'entrée**
est une **enveloppe JSON** :

```json
{
  "v": 1,
  "run_id": "uuid-généré-par-lumen",
  "input": "le texte de l'utilisateur",
  "callback": "http://127.0.0.1:8765/run/progress",
  "conversation_id": "id-conversation-ou-null",
  "lang": "fr"
}
```

Dans le raccourci : *Obtenir le contenu de l'entrée du raccourci* →
*Obtenir une valeur du dictionnaire* pour extraire `input`, `run_id`, `callback`.

## 2. Progression — ce que le routeur renvoie pendant l'exécution

Pour chaque étape/jalon, le routeur fait un **POST** sur l'URL `callback`
(`http://127.0.0.1:8765/run/progress`, alias `/run/event`) avec ce corps JSON :

```json
{
  "run_id": "le-même-run_id-que-l-entrée",
  "kind": "progress",
  "message": "Téléchargement des données…",
  "data": null
}
```

- `run_id` **obligatoire** (relie le retour à la bonne tâche/conversation).
- `kind` libre : `progress` (défaut), `step`, `status`, `log`, `tool`,
  `inference`/`model`/`ai`, `result`/`success`, `error`. La puce est colorée
  selon le `kind` : `progress` orange (défaut), `tool` violet,
  `inference`/`model`/`ai` blanc, `result`/`success` vert, `error` rouge,
  `image` rose.
- `message` : le texte affiché dans la discussion (Markdown léger supporté).
- `data` : facultatif (objet JSON quelconque, ignoré par l'UI pour l'instant).

Réponse de Lumen : `200 ok` immédiat. Le serveur est garanti actif (Lumen le
démarre avant le dispatch). Ces POST sont des **retours intermédiaires** : ils
donnent un suivi temps réel et un effet réactif, mais **ne portent pas le
résultat final**.

Dans le raccourci : *Obtenir le contenu de l'URL* → Méthode `POST`, *Corps de la
requête* = `JSON`, en ajoutant les champs ci-dessus. Cocher « ne pas afficher »
et idéalement « continuer en cas d'échec » pour ne jamais bloquer le flux.

## 2 bis. Envoyer une image (ex. Image Playground)

Pour afficher une image dans la discussion, encode-la en **Base64** et POSTe-la
sur `http://127.0.0.1:8765/run/image` :

```json
{
  "run_id": "le même run_id",
  "image_b64": "iVBORw0KGgo…",
  "mime": "image/png"
}
```

Lumen décode, **persiste** l'image (dossier `run_images` des données de l'app),
émet un évènement `run-progress` de `kind:"image"` portant son chemin relatif
(`/run/image/<id>`) et l'affiche dans la bulle — côté **bureau** (via
`127.0.0.1:8765`) comme côté **mobile** (via l'IP de l'ordinateur, même origine que la page
compagnon). L'image est servie par `GET /run/image/<id>`.

Dans le raccourci : *Image Playground* → *Encoder en Base64* → *Obtenir le
contenu de l'URL* (POST JSON ci-dessus).

## 2 ter. Afficher un widget (complication)

Le routeur peut afficher une **carte structurée** (façon complication Apple Watch)
en POSTant sur `http://127.0.0.1:8765/run/widget` :

```json
{
  "run_id": "le même run_id",
  "template": "weather",
  "title": "Paris",
  "accent": "#5b8def",
  "temp": 18, "unit": "C", "condition": "Nuageux",
  "location": "Paris", "hi": 21, "lo": 12,
  "hourly": [{ "time": "14h", "temp": 18 }, { "time": "15h", "temp": 19 }]
}
```

Le modèle/raccourci **choisit un `template`** et fournit ses champs ; Lumen dessine
la carte dans la bulle. Gabarits disponibles :

| `template` | Champs principaux |
|---|---|
| `weather` | `temp`, `unit`, `condition`, `location`, `hi`, `lo`, `hourly[]` |
| `metric` | `value`, `unit`, `label`, `trend` (`up`/`down`/`flat`), `delta`, `caption` |
| `stat-grid` | `items[]` : `{ label, value }` |
| `list` | `items[]` : `{ title, subtitle?, trailing? }` |
| `gauge` | `value` (0–100), `label`, `caption` |
| `report` | `status` (`success`/`error`/`running`), `lines[]` : `{ label, value, state? }`, `caption` |
| `sport` | `home`, `away`, `home_score`, `away_score`, `status` (ex. `Terminé`, `73'`, `Mi-temps`, `20:45`), `competition`/`league`, `home_logo`/`away_logo` (emoji optionnel) |

`title`, `accent` (hex) et `icon` sont optionnels et communs à tous les gabarits.

Exemple de résultat sportif (`sport`) — équipe gagnante mise en avant, point rouge
clignotant si le match est en direct :

```json
{
  "run_id": "le même run_id",
  "template": "sport",
  "competition": "Ligue 1",
  "home": "PSG", "home_logo": "🔴", "home_score": 2,
  "away": "OM", "away_logo": "⚪", "away_score": 1,
  "status": "73'"
}
```

(Alias acceptés : `score`, `match`. `status` détecte automatiquement l'état —
`Terminé`/`FT` = final, `73'`/`Mi-temps`/`Live` = en direct, sinon = à venir.)

## 2 quater. Notification flottante

En plus du panneau de progression *dans* la discussion, Lumen peut afficher une
**capsule flottante en verre**, indépendante de la fenêtre principale (et même
quand celle-ci est masquée). Elle hérite du thème clair/sombre de la barre de chat. À la différence des
callbacks `/run/*`, **aucun `run_id` n'est requis** : `/notify` est autonome et
peut être appelé par n'importe quel raccourci, à tout moment.

POSTe sur `http://127.0.0.1:8765/notify` :

```json
{
  "kind": "success",
  "icon": "sparkles",
  "title": "Sauvegarde terminée ✨",
  "body": "412 fichiers copiés en 3,2 s.",
  "accent": "#5b8def",
  "timeout_ms": 6000,
  "actions": [
    { "id": "open", "label": "Ouvrir", "primary": true },
    { "id": "dismiss", "label": "Plus tard" }
  ]
}
```

Tous les champs sont **optionnels** ; l'objet est transmis tel quel à la fenêtre
(`island.js`) :

- `kind` : pilote l'icône et la couleur par défaut. Valeurs reconnues —
  `info` (cloche), `success` (coche, vert), `warn` (triangle, ambre),
  `error` (rouge), `prompt` (bulle), `progress` (éclair), `thinking` (étincelles).
  Défaut : `info`.
- `icon` : force une icône, en surchargeant celle du `kind`. Jeu disponible :
  `bell`, `sparkles`, `check`, `warn`, `error`, `chat`, `heart`, `bolt`
  (un nom inconnu retombe sur l'icône du `kind`).
- `title` : titre en gras (texte échappé, pas de HTML).
- `body` (alias `message`) : corps de la notification (texte échappé).
- `accent` : couleur d'accent en hex (`#rrggbb`) ; sinon couleur du `kind`.
- `timeout_ms` : durée d'affichage en millisecondes avant disparition
  automatique (avec barre de minuterie). Défaut : **6000**. Mettre `0` pour
  rester affiché indéfiniment.
- `actions[]` : boutons cliquables, chacun `{ "id": "...", "label": "...",
  "primary": true? }`. Le premier bouton (ou celui marqué `primary`) est mis en
  avant. **Dès qu'il y a au moins une action (ou `kind:"prompt"`), le timeout
  passe par défaut à `0`** : la capsule reste tant qu'on n'a pas cliqué.

Réponse de Lumen : `200 ok` immédiat (le serveur local est garanti actif tant
que l'app tourne ; la fenêtre flottante est créée à la demande).

**File d'attente.** Les notifications s'affichent **une à la fois** : un second
`/notify` pendant qu'une capsule est visible est mis en file et présenté ensuite.

**Clic sur un bouton.** Le clic ferme la capsule et émet en interne l'évènement
Tauri `island-action` avec `{ id, kind, payload }` (`payload` = l'objet `/notify`
d'origine). Il n'y a **pas** de rappel HTTP automatique vers le routeur : la
réponse de l'utilisateur est destinée à un traitement côté bureau ; un raccourci
qui veut une réponse doit la collecter autrement (p. ex. via la mémoire `/mem`).

Exemple de test rapide en ligne de commande :

```bash
curl -X POST http://127.0.0.1:8765/notify \
  -H "Content-Type: application/json" \
  -d '{ "kind": "prompt", "icon": "heart", "title": "On lance le café ?",
        "body": "Choisis ton camp, humain.",
        "actions": [ { "id": "yes", "label": "Allez go", "primary": true },
                     { "id": "no", "label": "Plus tard" } ] }'
```

## 3. Résultat final — la sortie du raccourci

Deux façons de fournir le **résultat final**, au choix :

1. **Sortie du raccourci** (*Arrêter et générer la sortie*) → récupérée via
   `stdout` par Lumen. **Recommandé.**
2. **Dernier callback `kind:"result"`** (ou `success`/`answer`/`final`/`reply`/
   `done`) avec le texte dans `message`. Utile si ton raccourci ne renvoie rien
   en sortie : si le `stdout` est vide, Lumen utilise ce callback comme réponse
   (et le retire du panneau de progression pour éviter le doublon ; à défaut,
   il prend le dernier message texte reçu).

Dans les deux cas, Lumen affiche le résultat comme réponse de l'assistant et
l'énonce si l'auto-énonciation est active.

## Schéma

```
Lumen ──(enveloppe JSON via shortcuts run -i)──▶ Action Router
  ▲                                                  │
  │  POST /run/progress {run_id, kind, message}      │ (N fois, pendant l'exécution)
  └──────────────────────────────────────────────────┘
  ◀──(stdout = résultat final)────────────────────── Action Router
```

## Persistance / reprise

Lumen bufferise les évènements par `run_id` (rejouables via la commande
`run_events`) et **persiste** les étapes dans l'historique de la conversation :
elles réapparaissent quand on rouvre la discussion. Masquer la fenêtre (⌥Espace)
ou la recharger ne perd pas le suivi.

## Mémoire partagée (optionnelle)

Lumen expose une mémoire clé/valeur **persistante et facultative** sur la même
boucle locale que les callbacks — `http://127.0.0.1:8765/mem/…`. Elle sert de
todo, d'états, de mémoire utilisateur et de stockage commun, lisible/écrivable
par n'importe quel raccourci, **sans déclenchement préalable** par Lumen.

| Méthode + route | Effet |
|---|---|
| `GET /mem` (`?ns=todo/`) | Liste les entrées (filtre par préfixe optionnel) |
| `GET /mem/<clé>` | Lit une entrée (`404` si absente/expirée) |
| `PUT`/`POST /mem/<clé>` | Écrit la valeur (corps JSON). `?op=append` empile dans un tableau, `?rev=N` impose une écriture conditionnelle, `?ttl_ms=N` fixe une expiration |
| `DELETE /mem/<clé>` | Supprime |

La réponse d'une écriture renvoie l'entrée `{value, rev, updated_at, expires_at?}`.
Un conflit de révision renvoie `409 {error:"rev_conflict", current_rev}`. Les clés
sont namespacées par convention (`todo/`, `state/`, `user/`, `store/`) mais
aucune n'est imposée. Rien dans le fonctionnement de Lumen n'en dépend.

Exemple de boucle agentique dans un raccourci Heartbeat : `GET /mem/todo/list` →
choisir la prochaine tâche (Apple Intelligence) → agir → `POST /mem/state/last`
avec le résultat. Lumen garantit de son côté qu'un **second tick Heartbeat ne
démarre pas tant que le précédent n'a pas rendu son `stdout`**.

## Sécurité : boucle locale vs compagnon

- Les callbacks `/run/*`, la notification `/notify` et la mémoire `/mem/*`
  n'écoutent que sur **`127.0.0.1` (port 8765)** : accessibles aux raccourcis de
  la machine, jamais exposés au réseau. Aucune authentification requise.
- Le **compagnon mobile** écoute sur le LAN (**port 8766**) et est protégé par
  **TOTP** : appairage `POST /auth/pair {identifier, code}` → jeton de session
  passé en `?token=` sur le WebSocket et les images. Régénérer le secret
  (Paramètres → Compagnon) révoque tous les jetons.
