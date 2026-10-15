// Catalogue des connecteurs du centre de sources.
//
// Un connecteur, ici, c'est une FICHE : ce qu'il faut demander à l'utilisateur
// pour s'y brancher, et rien de plus. Le formulaire de la page est engendré à
// partir de ces descriptions — ajouter un connecteur côté Rust, c'est ajouter
// une entrée ici, jamais un écran de plus.
//
// Deux listes distinctes par connecteur :
//   * `config`  — réglages ordinaires, relus et modifiables ;
//   * `secrets` — mots de passe, jetons, clés : envoyés une fois, jamais
//     renvoyés par le backend (ils reviennent masqués). Un champ secret laissé
//     vide à la modification CONSERVE la valeur enregistrée.

const f = (key, label, opts = {}) => ({ key, label, ...opts });

export const KINDS = {
  postgres: {
    label: "PostgreSQL / PostGIS",
    family: "Bases de données",
    hint: "Base relationnelle d'entreprise, géométries PostGIS comprises.",
    config: [
      f("host", "Hôte", { placeholder: "localhost" }),
      f("port", "Port", { placeholder: "5432" }),
      f("database", "Base"),
      f("user", "Utilisateur"),
      f("schema", "Schéma", { placeholder: "public" }),
    ],
    secrets: [f("password", "Mot de passe", { type: "password" }), f("url", "…ou chaîne de connexion complète", { type: "password", hint: "host=… dbname=… — remplace les champs ci-dessus." })],
    pro: true,
  },
  mysql: {
    label: "MySQL / MariaDB",
    family: "Bases de données",
    hint: "Le socle de la plupart des applications métier et des CMS.",
    config: [
      f("host", "Hôte", { placeholder: "localhost" }),
      f("port", "Port", { placeholder: "3306" }),
      f("database", "Base"),
      f("user", "Utilisateur"),
    ],
    secrets: [f("password", "Mot de passe", { type: "password" }), f("url", "…ou URL mysql://", { type: "password" })],
    pro: true,
  },
  sqlite: {
    label: "SQLite",
    family: "Bases de données",
    hint: "Un fichier .db ou .sqlite, ouvert en lecture seule.",
    config: [f("path", "Chemin du fichier", { placeholder: "/Users/moi/data/base.sqlite", wide: true })],
    secrets: [],
  },
  mssql: {
    label: "SQL Server",
    family: "Bases de données",
    hint: "Microsoft SQL Server, sur site ou Azure SQL.",
    config: [
      f("host", "Hôte", { placeholder: "localhost" }),
      f("port", "Port", { placeholder: "1433" }),
      f("database", "Base"),
      f("user", "Utilisateur"),
      f("trust_certificate", "Accepter un certificat auto-signé", { type: "toggle" }),
    ],
    secrets: [f("password", "Mot de passe", { type: "password" }), f("url", "…ou chaîne ADO", { type: "password" })],
    pro: true,
  },
  excel: {
    label: "Excel / OpenDocument",
    family: "Fichiers",
    hint: "Un classeur, ou un dossier de classeurs. Chaque feuille devient un jeu de données.",
    config: [f("path", "Fichier ou dossier", { placeholder: "/Users/moi/Documents/ventes.xlsx", wide: true })],
    secrets: [],
  },
  csv: {
    label: "CSV",
    family: "Fichiers",
    hint: "Un fichier ou un dossier ; chaque fichier devient un jeu de données.",
    config: [
      f("path", "Fichier ou dossier", { placeholder: "/Users/moi/Documents/exports", wide: true }),
      f("delimiter", "Séparateur", { placeholder: ", (défaut)" }),
    ],
    secrets: [],
  },
  rest: {
    label: "API REST",
    family: "Services",
    hint: "Les points d'entrée sont déclarés ici : le modèle choisit parmi eux, il ne compose pas d'URL.",
    config: [
      f("base_url", "URL de base", { placeholder: "https://api.exemple.fr/v1", wide: true }),
      f("auth", "Authentification", { type: "select", options: ["bearer", "header", "basic", "none"] }),
      f("header", "Nom d'en-tête", { placeholder: "Authorization (si mode « header »)" }),
      f("user", "Utilisateur (mode basic)"),
      f("limit_param", "Paramètre de taille de page", { placeholder: "limit" }),
      f("offset_param", "Paramètre de décalage", { placeholder: "offset" }),
      f("endpoints", "Points d'entrée (JSON)", {
        type: "textarea", wide: true,
        placeholder: '[{ "name": "clients", "path": "/clients", "rowsPath": "data.items" }]',
        hint: "name : le nom du jeu de données. path : le chemin relatif. rowsPath : où sont les lignes dans la réponse (facultatif).",
      }),
    ],
    secrets: [f("token", "Jeton", { type: "password" }), f("password", "Mot de passe (mode basic)", { type: "password" })],
  },
  webdav: {
    label: "WebDAV",
    family: "Stockage",
    hint: "N'importe quel partage WebDAV.",
    config: [
      f("base_url", "URL du partage", { placeholder: "https://dav.exemple.fr/partage", wide: true }),
      f("auth", "Authentification", { type: "select", options: ["basic", "bearer", "none"] }),
      f("user", "Utilisateur"),
    ],
    secrets: [f("password", "Mot de passe", { type: "password" }), f("token", "Jeton", { type: "password" })],
  },
  nextcloud: {
    label: "Nextcloud",
    family: "Stockage",
    hint: "Utilisez un mot de passe d'application, jamais celui du compte.",
    config: [
      f("base_url", "URL de l'instance", { placeholder: "https://cloud.exemple.fr", wide: true }),
      f("user", "Utilisateur"),
      f("auth", "Authentification", { type: "select", options: ["basic"] }),
    ],
    secrets: [f("password", "Mot de passe d'application", { type: "password" })],
  },
  s3: {
    label: "S3 / MinIO",
    family: "Stockage",
    hint: "Compatible AWS S3 : MinIO, Scaleway, OVH, Wasabi…",
    config: [
      f("base_url", "Point de terminaison", { placeholder: "https://s3.eu-west-3.amazonaws.com", wide: true }),
      f("bucket", "Bucket"),
      f("region", "Région", { placeholder: "us-east-1" }),
    ],
    secrets: [f("access_key", "Clé d'accès", { type: "password" }), f("secret_key", "Clé secrète", { type: "password" })],
  },
  sharepoint: {
    label: "SharePoint",
    family: "Microsoft 365",
    hint: "Jeton Microsoft Graph avec la portée Sites.Read.All.",
    config: [f("site_id", "Identifiant du site", { wide: true }), f("drive_id", "Bibliothèque (facultatif)", { wide: true })],
    secrets: [f("token", "Jeton d'accès Graph", { type: "password" })],
  },
  onedrive: {
    label: "OneDrive",
    family: "Microsoft 365",
    hint: "Jeton Microsoft Graph avec la portée Files.Read.",
    config: [f("user_id", "Utilisateur (vide = le vôtre)", { wide: true })],
    secrets: [f("token", "Jeton d'accès Graph", { type: "password" })],
  },
  gdrive: {
    label: "Google Drive",
    family: "Google",
    hint: "Jeton OAuth avec la portée drive.readonly. Les documents Google sont exportés en texte.",
    config: [f("folder_id", "Dossier de départ (vide = racine)", { wide: true })],
    secrets: [f("token", "Jeton d'accès", { type: "password" })],
  },
  github: {
    label: "GitHub",
    family: "Services",
    hint: "Contenu d'un dépôt. Un jeton à portée « contents: read » suffit.",
    config: [
      f("owner", "Propriétaire", { placeholder: "organisation ou utilisateur" }),
      f("repo", "Dépôt"),
      f("ref", "Branche ou tag", { placeholder: "main" }),
      f("base_url", "API (GitHub Enterprise)", { placeholder: "https://api.github.com", wide: true }),
    ],
    secrets: [f("token", "Jeton d'accès", { type: "password" })],
  },
};

export const KIND_IDS = Object.keys(KINDS);

/** Connecteurs regroupés par famille, dans l'ordre d'affichage du sélecteur. */
export function byFamily() {
  const out = new Map();
  for (const id of KIND_IDS) {
    const fam = KINDS[id].family;
    if (!out.has(fam)) out.set(fam, []);
    out.get(fam).push(id);
  }
  return out;
}

export const kindLabel = (id) => KINDS[id]?.label || id;
