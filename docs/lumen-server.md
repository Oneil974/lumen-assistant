# Lumen Server — architecture

Document de conception **validé** (07/09/2026). Il décrit un produit nouveau et
distinct : un serveur d'équipe pour Lumen Pro. Les arbitrages ouverts de la
première version ont été tranchés ; la section 13 en garde la trace.

## 1. Ce que c'est, et ce que ce n'est pas

Lumen Server est un **serveur d'organisation auto-hébergé** : une machine du
réseau (poste dédié, NAS, petit serveur Linux) qui porte ce que plusieurs
personnes doivent partager — les identités, les messages, les réunions, la
puissance d'inférence, les tables de DB Studio, l'exécution des agents.

Trois principes le tiennent :

1. **Lumen Pro reste entier sans lui.** Aucune fonction existante ne doit
   cesser de marcher quand aucun serveur n'est configuré. Le serveur ajoute le
   collectif ; il ne devient pas une dépendance du travail solitaire.
2. **Un serveur = une organisation.** Ce n'est pas un service multi-locataires.
   Pas de cloisonnement entre clients à concevoir, donc pas de faux sentiment
   d'isolation à entretenir.
   Et **un seul serveur complet** par organisation : les autres machines du
   maillage sont des *nodes* d'inférence (section 7), pas des serveurs pairs.
3. **Le réseau local d'abord.** LAN ou VPN. L'exposition sur Internet est
   possible mais reste un choix explicite de l'administrateur, avec ce que cela
   implique (section 10).

Ce n'est pas un cloud Lumen, pas un service géré, et pas un tunnel : il n'y a
aucun serveur d'Anthropic ni de tiers dans le chemin.

**Produit distinct.** Lumen Server ne se livre pas avec Lumen Pro : autre
binaire, autre cycle de version, autre page de téléchargement. Les deux ne se
connaissent que par le protocole de la section 4.

## 2. Stack et build

Projet séparé, à la racine du dépôt : `lumen-server/`.

| Élément | Valeur |
|---|---|
| Stack | Tauri 2 + Rust, comme Lumen — mais **projet et build indépendants** |
| Bundle | `com.lumen.server`, `productName` « Lumen Server » |
| Forme | **Démon** `lumen-serverd` — le vrai produit, pensé pour une machine sans écran |
| Interface | **Console web servie par le démon**, activable au lancement (`--console`, active par défaut) |
| Application | Enveloppe Tauri optionnelle autour de cette même console, pour un poste avec écran |
| Identité visuelle | Bleu là où Lumen Pro est or : `lib/server-skin.css` sous `:root[data-edition="server"]` |
| Icônes | `lumen-server/icons/`, régénérées depuis une source bleue par `npx tauri icon` |
| Données | `lumen-server.db` (SQLite WAL) + `blobs/` dans le dossier de données du serveur |

**Une seule interface, deux façons de l'ouvrir.** La console est une page web
servie par le démon ; l'application de bureau n'en est qu'une fenêtre. Écrire
deux interfaces pour le même produit, c'est s'engager à en laisser une pourrir.

**Partage de code.** Aucune crate commune au départ, sauf une : le protocole.
`lumen-server/crates/lumen-proto` définit les enveloppes et les types échangés
(serde), et Lumen Pro la **vendorise** dans `src-tauri/crates/lumen-proto` avec
un script de resynchronisation — exactement le procédé déjà retenu pour le
moteur Fluxo. Une dépendance de chemin entre deux dépôts se casse à la première
publication ; une copie synchronisée par script se répare en une commande.

Le reste (catalogue de modèles, runtime d'agents) est **réécrit en plus mince**
côté serveur plutôt que partagé : le code de Lumen est couplé à Tauri
(`AppHandle`, `State`, événements de fenêtre), et l'en extraire coûterait plus
cher que d'en réécrire la part utile.

## 3. Annuaire — le socle de tout le reste

### Modèle

```
accounts(id, handle, display_name, avatar, email, role, status, created_at)
devices(id, account_id, name, token_hash, last_seen, created_at)
groups(id, name, description)
memberships(group_id, account_id, role)
audit_log(id, at, account_id, action, target, detail)
```

`role` vaut `admin` ou `member`. `status` vaut `active` ou `suspended` — un
compte suspendu garde son historique mais aucun jeton ne s'ouvre.

### Appairage

Un compte n'a pas de mot de passe réseau. L'administrateur crée le compte, la
console affiche un **code d'appairage à usage unique** (valable 10 minutes) ;
Lumen Pro le saisit une fois et reçoit un **jeton d'appareil** de 32 octets.

Le jeton n'est jamais stocké en clair côté serveur : seul son SHA-256 salé est
en base, comme les mots de passe de session (`session.rs`). Un appareil perdu se
révoque seul, sans toucher aux autres.

### Ce que le client voit

`GET /v1/directory` renvoie les comptes actifs : identifiant, handle, nom
affiché, avatar, présence. Jamais d'adresse e-mail ni de métadonnée d'appareil :
un annuaire sert à joindre quelqu'un, pas à l'inventorier.

## 4. Protocole temps réel

**Une seule socket par appareil**, `wss://serveur:8770/ws`, jeton en en-tête.
Tout ce qui est vivant y passe : présence, messages, frappe en cours,
invitations de réunion, signalisation WebRTC, événements d'agents,
notifications. Ouvrir un socket par fonction multiplierait les reconnexions et
les états de bord.

Enveloppe :

```json
{ "v": 1, "id": "01J...", "t": "msg", "ts": 1757250000, "p": { } }
```

| Type | Sens |
|---|---|
| `hello` | Le serveur annonce sa version, les capacités activées, l'identité reconnue |
| `presence` | Arrivée, départ, statut d'un compte |
| `msg` / `msg.ack` | Message, puis accusé porteur de l'identifiant serveur |
| `typing` | Frappe en cours, non persistée |
| `meet.invite` / `meet.signal` | Salle proposée ; offres, réponses et candidats ICE |
| `agent.event` | Progression d'un run, et **demande d'approbation** d'un effet |
| `sub` | Abonnement à une conversation ou à une salle |
| `error` | Refus explicite, jamais un silence |

**Reprise.** Chaque message client porte un `client_msg_id` unique : le serveur
en fait une clé d'idempotence, si bien qu'un renvoi après coupure ne crée pas de
doublon. À la reconnexion, le client donne son curseur par conversation et
reçoit ce qu'il a manqué. Reconnexion à backoff exponentiel plafonné.

**REST à côté.** Tout ce qui n'est pas vivant — annuaire, historique, pièces
jointes, catalogue, administration — passe par une API REST sur le même port.
Même partage des rôles que le centre de sources de données : REST pour ce qui se
lit, socket pour ce qui arrive.

## 5. Messagerie

```
conversations(id, kind, title, created_by, created_at)      -- direct | group
conversation_members(conversation_id, account_id, joined_at, cursor)
messages(id, conversation_id, author_id, body, attachments, created_at, edited_at)
receipts(message_id, account_id, state, at)                 -- delivered | read
```

Conversations directes et de groupe, historique porté par le serveur — c'est
précisément ce qu'un poste isolé ne peut pas offrir. Pièces jointes en
`POST /v1/blobs`, chiffrées avant dépôt, bornées à 10 Mio et adressées par
empreinte SHA-256. La lecture exige d'être membre de la conversation et le
client vérifie l'empreinte avant de déchiffrer.

L'app côté Lumen Pro suit les codes qu'on attend d'une messagerie (liste de
conversations, fil, présence, brouillons, accusés) **dans la langue visuelle de
Lumen** : mêmes jetons de couleur, même coquille d'application, aucune bulle
empruntée à un autre produit.

**Chiffrement de bout en bout.** Le serveur ne stocke que du **chiffré** : il
relaie et conserve des enveloppes qu'il ne sait pas ouvrir.

- Chaque appareil produit à l'appairage une paire de clés X25519 et publie sa
  clé publique dans l'annuaire. La clé privée ne quitte jamais l'appareil.
- Un message est chiffré une fois **par appareil destinataire** (ChaCha20-
  Poly1305, clé de session dérivée par X25519), puis remis au serveur sous forme
  d'une enveloppe par destinataire.
- Le serveur voit : qui écrit à qui, quand, et la taille. Il ne voit pas le
  contenu, ni les pièces jointes (chiffrées de la même façon avant dépôt).

Trois conséquences qu'il faut assumer plutôt que découvrir :

1. **La recherche est locale.** Le serveur ne peut pas indexer ce qu'il ne lit
   pas ; c'est chaque poste qui cherche dans son historique déchiffré.
2. **Un nouvel appareil ne lit pas le passé** — il n'était pas destinataire des
   enveloppes. Il démarre au moment de son appairage. C'est le comportement des
   messageries chiffrées sérieuses, et il vaut mieux le dire à l'écran.
3. **Perdre tous ses appareils, c'est perdre son historique.** Aucun
   administrateur ne peut le restituer. C'est le prix exact du chiffrement de
   bout en bout.

L'administrateur garde le pouvoir sur les *accès* (bloquer un compte, révoquer
un appareil), jamais sur les *contenus*.

## 6. Réunions

Le serveur devient le point de **signalisation** : salles nommées, invitations
adressées à des comptes de l'annuaire, jetons de salle à durée limitée. Les flux
audio et vidéo restent pair-à-pair (WebRTC) ; le serveur ne les relaie pas.

`meet.rs` conserve son mode actuel — un poste Lumen héberge la salle sur le port
8767 — lorsqu'aucun serveur n'est configuré. Le serveur ne remplace pas ce
mode : il en corrige les limites (l'hôte doit rester allumé, les invités se
désignent à la main).

**Limite connue** : hors LAN/VPN, les pairs derrière deux NAT symétriques ne
s'atteignent pas sans relais TURN. Le serveur ne fait pas TURN au jalon 3 ; s'il
le faut, c'est un composant à ajouter (section 13).

## 7. Inférence et maillage

### Le serveur d'inférence

Le serveur **embarque llama.cpp**, comme Lumen : il lance le processus, l'arrête,
change de modèle, télécharge les GGUF et recharge au démarrage celui qui
servait. Rien à installer ni à surveiller à côté.

Deux limites assumées : le **binaire** `llama-server` n'est pas téléchargé (le
bon build dépend du matériel — Metal, CUDA, CPU — et ce choix revient à
l'administrateur ; le serveur le cherche à côté de lui et dit clairement s'il
manque), et un processus ne sert **qu'un modèle à la fois** — changer de modèle
demande un redémarrage de quelques secondes, que le statut affiche au lieu de le
masquer.

Le moteur écoute sur `127.0.0.1` uniquement : il n'est joignable que par le
serveur, qui l'expose ensuite avec ses contrôles d'accès. Ouvrir son port
reviendrait à offrir une API d'inférence sans jeton.

Il expose une API **compatible OpenAI** (`/v1/chat/completions`,
`/v1/embeddings`, `/v1/models`). C'est le choix d'intégration le moins coûteux
et le plus honnête : Lumen sait déjà parler à un backend OpenAI-compatible, donc
pointer un poste vers le serveur revient à changer une URL et une clé — pas à
écrire un client.

### Le maillage : un serveur, des nodes

Le maillage n'est pas un réseau de serveurs égaux. Il y a **un serveur complet**
— identités, messages, réunions, base, agents — et autour, des **nodes** qui ne
font qu'une chose : servir de l'inférence llama.cpp avec leur catalogue. Un node
n'a ni annuaire, ni messagerie, ni base ; il n'a donc presque aucune surface
d'attaque et s'installe sur n'importe quelle machine qui a une carte graphique.

Le serveur connaît une **liste blanche de nodes** (pas de découverte
automatique : sur un réseau d'entreprise, une découverte est une surface
d'attaque). Chaque node s'annonce périodiquement :

```json
{ "node": "gpu-atelier", "models": ["qwen3-8b-q4"], "queue": 2,
  "free_vram_mb": 9200, "p50_ms": 380, "sig": "hmac-sha256:…" }
```

Les annonces sont signées par un secret partagé : un node non signé n'entre pas
dans la table de routage.

**Routage d'une requête**, dans cet ordre :

1. le modèle demandé est déjà chargé localement et la file est courte → local ;
2. un node l'a déjà chargé → on lui proxifie la requête, flux SSE compris ;
3. sinon, le node le moins chargé capable de le charger ;
4. à défaut, local, quitte à charger le modèle.

**Un seul saut, par construction.** Un node ne route pas : il exécute. Il n'y a
donc aucune chaîne possible, et aucune boucle à détecter — c'est le bénéfice
direct d'avoir séparé le serveur des nodes plutôt que d'avoir fait des pairs.

## 8. Base de données de DB Studio

Le serveur héberge les tables : c'est ce qui permet à plusieurs personnes de
saisir dans la même.

**Deux moteurs, une seule interface.** Toute la persistance du serveur passe par
un trait `Store` avec deux implémentations : **SQLite** (défaut, zéro
installation, parfait pour une petite équipe) et **PostgreSQL** (`--db
postgres://…`), pour les organisations qui ont déjà un SGBD, des sauvegardes et
un administrateur. Le choix se fait au lancement et ne change rien au reste du
code. C'est aussi ce que DB Studio sait déjà viser côté client — la
modélisation ne bouge pas quand le moteur change.

**Migration des droits.** Le partage d'espaces livré récemment vise des profils
**locaux** (`session_profiles`). Avec l'annuaire, `owner` et `grants` doivent
viser des `account_id`. `dbshare.rs` a été écrit pour que ce soit un changement
de *source d'identité* — une fonction `me()` et une table de correspondance — et
non une réécriture. La conversion des partages existants se fait une fois, au
moment où le poste se lie au serveur, et reste réversible tant que le poste
n'a pas basculé.

## 9. Orchestrateur d'agents

Les agents définis dans Lumen Pro (définition, skills, critères d'acceptation)
sont publiés au serveur. Le serveur conserve les runs et les attribue
atomiquement à un worker Pro connecté du propriétaire; ce worker utilise le
runtime durable local existant et ses leases, retries et DAG de plan. Cette
première exécution distribuée garde les connecteurs et secrets sur le poste :
un run attend donc qu'un Lumen Pro du propriétaire soit connecté. L'exécution
autonome par un démon sans poste connecté demandera un runtime serveur isolé et
un modèle explicite de délégation des identifiants.

Deux règles :

- **Le contexte reste celui du compte** qui a publié l'agent. Pas de secrets
  partagés entre comptes, pas d'agent qui hérite des accès d'un autre.
- **Les approbations remontent à la personne.** Un effet `external` ou
  `destructive` suspend le run et pousse une demande par la socket ; elle
  s'approuve depuis Lumen Pro ou depuis le compagnon mobile, jamais depuis la
  console du serveur à la place de l'utilisateur.

## 10. Sécurité

| Point | Décision |
|---|---|
| Transport | TLS obligatoire hors `127.0.0.1`. Certificat auto-signé accepté une fois, empreinte épinglée côté client |
| Jetons | 32 octets aléatoires, stockés hachés et salés, révocables appareil par appareil |
| Fichiers | Base et secrets en 0600; blobs chiffrés en 0600 dans un dossier 0700 |
| Mesh | Liste blanche + annonces signées HMAC ; aucune découverte réseau |
| Journal | Table `audit_log` : création de compte, appairage, révocation, changement de droits |
| Débit | Limitation par appareil sur l'appairage et l'inférence |

**Ce qui n'est pas garanti**, et doit être écrit dans le produit comme ici : les
**messages** sont chiffrés de bout en bout, mais les **tables** de DB Studio et
les fichiers déposés ne le sont pas — l'administrateur du serveur peut les lire,
et un serveur compromis les expose. Le serveur voit aussi les métadonnées de la
messagerie : qui écrit à qui, quand, et combien. Lumen Server déplace la
confiance vers une machine ; il la réduit sur les messages, il ne la supprime
nulle part.

## 11. Côté Lumen Pro

Trois ajouts, tous inertes quand aucun serveur n'est configuré :

- **Annuaire** — les personnes du réseau : présence, fiche, actions (écrire,
  inviter en réunion, partager un espace de saisie).
- **Messagerie** — conversations directes et de groupe.
- **Extension du partage d'espaces** aux identités réseau (section 8).

Plus un écran de liaison dans les Paramètres : adresse du serveur, code
d'appairage, empreinte du certificat, état de la connexion.

## 12. Jalons

Chaque jalon est livrable et vérifiable seul.

| # | Contenu | État |
|---|---|---|
| J1 | Stack `lumen-server`, démon, console web, comptes, appairage, REST annuaire | **fait** — vérifié de bout en bout |
| J2 | Passerelle WS, présence, messagerie chiffrée de bout en bout ; app Messagerie | **implémenté** — enveloppes E2E et pièces jointes AES-GCM ; vérification en webview à faire |
| J3 | Réunions signalées par le serveur ; app Annuaire | **fait** — salles et relais de signalisation ; l'app Annuaire invite |
| J4 | Inférence : **llama.cpp embarqué** + API compatible OpenAI | **fait** — téléchargement, démarrage, proxy en flux, vérifiés sur un vrai GGUF |
| J5 | Nodes d'inférence et routage | **fait** — annonces signées vérifiées, node inconnu et non signé refusés |
| J6 | Base DB Studio serveur (SQLite **et** PostgreSQL) + droits par compte | **fait** — quatre cas de droits vérifiés, sous-partage refusé |
| J7 | Orchestrateur d'agents | **implémenté** — file durable, attribution par propriétaire, heartbeats et exécution par le Lumen Pro connecté du propriétaire |

### Ce qui n'a pas pu être vérifié à l'exécution

* **Le chiffrement de bout en bout et les pièces jointes** n'ont pas été
  exercés dans une webview : le client utilise WebCrypto et le serveur ne garde
  que les blobs chiffrés, mais le parcours multi-appareils reste à valider dans
  l'application.
* **PostgreSQL** : le code des deux moteurs est écrit et compile ; seul SQLite
  est couvert par `cargo test`, qui n'a besoin de personne.

### Écart assumé avec le plan : la primitive de chiffrement

Le plan prévoyait X25519 + ChaCha20-Poly1305. L'implémentation utilise
**ECDH P-256 + HKDF-SHA256 + AES-GCM** : X25519 n'est pas disponible dans
WebCrypto sur toutes les webviews que Lumen vise (WKWebView, WebKitGTK), P-256
l'est partout. Le niveau de sécurité pratique est le même, et du chiffrement qui
tourne vaut mieux que du chiffrement qui figure au plan.

## 13. Décisions tranchées

| # | Question | Décision (07/09/2026) |
|---|---|---|
| 1 | Ports | `8770` pour REST + WS + console. `8767` reste au mode hôte local des réunions |
| 2 | Chiffrement de la messagerie | **Bout en bout dès J2**, avec ce que cela coûte : recherche locale, pas de reprise du passé sur un nouvel appareil |
| 3 | Source d'identité | Un compte **devient réseau** dès la liaison au serveur ; l'administrateur peut le bloquer, ce qui ferme tous ses appareils |
| 4 | Mode sans interface | Le démon est le produit ; il **sert lui-même la console web**, activable au lancement. L'application de bureau n'est qu'une fenêtre sur cette console |
| 5 | TURN | **Non.** Réunions sur LAN/VPN ; hors de là, c'est une limite assumée et documentée |
| 6 | Édition et licence | **Produit distinct** de Lumen Pro : binaire, versions et distribution séparés |
| 7 | Maillage | **Un serveur complet, des nodes d'inférence.** Un node ne fait que llama.cpp et son catalogue |
| 8 | Moteur de base | **SQLite ou PostgreSQL**, choisis au lancement derrière un trait `Store` |

## 14. Reste à décider

1. **Sauvegarde et restauration** du serveur : quel format, et que devient
   l'historique chiffré (qui n'est restaurable que par les appareils) ?
2. **Fédération entre organisations** : deux Lumen Server qui se parlent, ou
   jamais ?
3. **Rotation des clés d'appareil** : durée de vie, et procédure quand un
   appareil est perdu alors qu'il portait le seul historique.
