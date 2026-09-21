# Catalogue Lumen (manifeste du Market)

`manifest.json` est le **catalogue distant officiel** du Market de Lumen. L'app le charge à
l'ouverture de l'écran Market, l'ajoute à son catalogue embarqué, et le relit à chaque
ouverture : le mettre à jour ici suffit à proposer un nouveau workflow ou un nouvel avatar,
sans publier de nouvelle version de l'application.

## Où l'app va le chercher

```
https://raw.githubusercontent.com/Oneil974/lumen-app/main/market/manifest.json
```

L'URL est définie par `OFFICIAL_MANIFEST_URL` dans `src/market/catalog.js` (dépôt de dev).
**À corriger le jour où ce dépôt est renommé** (`lumen-app` → `lumen-assistant`) : les URL
`raw.githubusercontent.com` suivent mal les renommages. Le fichier est aussi servi par la page
GitHub Pages du dépôt, à `https://oneil974.github.io/lumen-app/market/manifest.json`.

Trois catalogues s'additionnent dans le Market, sans jamais se remplacer :

1. le catalogue **embarqué** (`src/market/catalog.js`) — disponible hors ligne ;
2. ce manifeste **officiel** ;
3. le manifeste **personnel** de l'utilisateur, ajouté par URL dans l'onglet « Source ».

Un manifeste injoignable (hors ligne, dépôt privé, JSON invalide) n'empêche rien : le Market
affiche simplement les autres catalogues.

## Format

```json
{
  "version": 1,
  "updated": "2026-09-03",
  "workflows": [
    {
      "id": "identifiant-stable",
      "category": "Productivité",
      "title": "Titre affiché",
      "description": "Une phrase : ce que ça fait.",
      "needs": ["Un modèle local ou une clé API"],
      "setup": "Réglage à faire après installation (optionnel).",
      "workflow": { "name": "…", "trigger": { "type": "manual" }, "steps": [] }
    }
  ],
  "avatars": [
    {
      "id": "identifiant-stable",
      "title": "Nom de l'avatar",
      "description": "Style, auteur, licence…",
      "author": "Auteur",
      "sizeLabel": "≈ 8 Mo",
      "url": "https://…/avatar.glb"
    }
  ]
}
```

Un troisième tableau, `featured`, alimente le carrousel en tête de rayon :

```json
{
  "featured": [
    {
      "id": "identifiant-stable",
      "section": "workflows",
      "target": "identifiant-d-un-element-du-meme-rayon",
      "eyebrow": "Nouveau",
      "title": "Titre de la lame",
      "subtitle": "Une phrase de mise en avant."
    }
  ]
}
```

`section` vaut `models`, `voices`, `workflows` ou `avatars`. `target` est facultatif : présent, il
ajoute un bouton « Voir la fiche » qui ramène à l'élément dans la grille. Les lames sont
typographiques — le Market n'affiche aucune image.

Les entrées incomplètes sont ignorées silencieusement : un workflow sans `workflow.name` et un
avatar sans `url` ne sont pas affichés.

### Workflows

L'objet `workflow` est exactement celui qu'enregistre le designer Fluxo (`save_workflow`). Le
plus sûr pour en ajouter un : le composer dans Fluxo → Designer, puis recopier ici le JSON
écrit dans `<données de l'app>/workflows/<nom>.json`.

Deux règles à respecter :

- chaque paramètre est un objet typé — `{"type": "text", "value": "…"}`, `"number"`, `"bool"` ;
- une étape référence la sortie d'une autre par son `id` : `{{llm_infer1}}` (et `{{input}}`
  pour l'entrée du workflow).

Les identifiants d'action disponibles sont ceux du moteur :
`src-tauri/crates/fluxo-engine/src/actions/mod.rs`.

### Avatars

Les GLB ne sont pas hébergés ici : le manifeste ne porte que des URL. Le fichier visé doit
respecter le contrat d'avatar de Lumen, sinon l'installation est refusée côté Rust :

- format **glTF 2.0 binaire** (`.glb`), moins de 25 Mo ;
- quatre animations aux noms exacts, sensibles à la casse : `Lumen_Idle`, `Lumen_Thinking`,
  `Lumen_Speaking`, `Lumen_Action` (`Lumen_Heartbeat` est optionnelle).

L'URL doit être servie en HTTPS et autoriser la lecture depuis l'application (CORS).

## Publier une mise à jour

1. Modifier `manifest.json`, vérifier qu'il est valide (`python3 -m json.tool market/manifest.json`).
2. Pousser sur la branche par défaut du dépôt public.
3. Dans le Market, onglet **Source** → « Actualiser le catalogue Lumen ».
