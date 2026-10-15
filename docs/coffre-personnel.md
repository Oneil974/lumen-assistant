# Coffre personnel

Le coffre devient une application du bureau, dans l’espace **Données**, accessible aussi depuis Réglages → Compagnon → Coffre. Les anciennes clés, les historiques, les outils Fluxo et la synchronisation des valeurs avec les appareils appairés sont conservés.

## Un dossier qui devient une collection

Une collection possède un chemin stable, un nom, une description et des champs typés. Un projet devient par exemple une fiche `projets/atelier`, avec ses champs nom, objectif, statut et échéance. Le chemin reste utilisable par les workflows ; les libellés rendent la fiche lisible pour l’utilisateur. Les dossiers existants sont toujours visibles et peuvent devenir des collections si leurs données respectent la structure définie.

Les vues cartes et tableau, la recherche dans les champs, le tri, les filtres par champ et valeur, les dossiers imbriqués et le panneau latéral permettent de parcourir et modifier les données. Les objets et listes libres disposent d’un explorateur dépliable. Les collections Contacts, Projets, Inventaire et Préférences servent de points de départ. Aucun jeu de démonstration n’est ajouté au coffre réel.

## Écriture et récupération

Les champs et leurs types sont vérifiés côté Rust. Un changement de structure incompatible avec des fiches existantes est refusé, sans modifier leurs données. L’import JSON vérifie toutes les fiches avant une écriture unique, accepte jusqu’à 500 fiches et refuse les remplacements implicites. L’export JSON conserve types et chemins ; le CSV est destiné aux tableurs. L’import accepte un tableau d’objets ou le format d’export `lumen-vault/1` dans une collection existante.

L’enregistrement et la suppression d’une fiche comparent sa version à celle actuellement stockée. Une modification concurrente doit être rechargée avant l’écriture. Les dix dernières versions restent consultables et peuvent être chargées dans l’éditeur puis enregistrées. La suppression propose une annulation immédiate ; elle conserve les tombstones nécessaires à la synchronisation. L’ajout à une liste est réalisé sous le même verrou que son enregistrement, pour éviter les pertes entre deux ajouts simultanés.

Le stockage reste le fichier JSON par profil existant : collections et schémas y ajoutent une structure de base documentaire, sans migration destructive vers un autre moteur. Les écritures utilisent un fichier temporaire puis un remplacement atomique. Un fichier illisible ne peut pas être remplacé silencieusement par un coffre vide.

## Lumen et les workflows

Chaque collection propose trois accès : privé, lecture IA, lecture et écriture IA. Les collections privées sont exclues des outils `vault_*` et de l’index du coffre utilisé par `data_search`. L’accès des appareils appairés reste inchangé ; les données déjà partagées dans une conversation ou copiées dans une autre application ne sont pas effacées rétrospectivement.

`vault_schema` expose uniquement les structures accessibles ; `vault_query` renvoie des fiches structurées, avec recherche texte, filtre exact champ → valeur et pagination. Les outils historiques `vault_get`, `vault_list`, `vault_set` et `vault_append` respectent les accès des collections. Pour modifier une fiche depuis l’IA, lisez sa structure puis utilisez `vault_set` avec le chemin et `type=dict` ; les champs sont vérifiés côté serveur.

Dans le coffre, **Interroger avec Lumen** propose une question en langage naturel. L’agent utilise uniquement un outil de lecture dont la collection est fixée, et le moteur IA actif de Lumen. Les collections privées n’affichent pas ce bouton.

Studio Nodal possède les blocs Structure du coffre et Interroger une collection, en plus des lectures/écritures de clés. Ils fonctionnent directement ou en mode outil pour un agent ; l’embed passe par le pont authentifié `/device/nodal`, les secrets restant sur le serveur. Les écritures de l’embed restent désactivées tant que `LUMEN_ALLOW_WRITES=true` n’est pas configuré.

## Validation

Tests du modèle JavaScript : types, champs requis, frontières des dossiers, recherche, import sans remplacement et export CSV. Tests Rust : schémas, accès IA, compatibilité du format existant, historique et tombstones. Harnais `src/vault/__preview-vault.html` exclusivement en mémoire pour vérifier l’interface sans toucher aux données personnelles.

## Compagnons et apparence

Le coffre utilise les jetons `--primary` / `--primary-foreground` de Lumen pour les actions, les icônes, les sélections et le focus. Les changements d’accent suivent les préférences partagées. Le compagnon réseau ouvre la même interface responsive depuis Discussion ou Messages. Le compagnon iOS propose **Coffre personnel** dans son explorateur : vue intégrée éphémère, certificat vérifié selon l’épinglage existant, jeton en session et en en-tête HTTP, jamais dans l’URL. Les valeurs hors ligne et Raccourcis restent accessibles dans le parcours natif ; les structures de collections rejoignent leur synchronisation.

`POST /vault/operation` n’accepte que les opérations du coffre et utilise exclusivement le profil obtenu du jeton appairé. Les fiches et les schémas conservent les validations et les vérifications de version du bureau. L’interrogation mobile utilise le modèle actif, sans outil d’écriture, sur un échantillon borné à 50 fiches / 24 Ko ; elle nécessite le profil actif du Mac. Elle annonce cette limite et refuse les collections privées. Une synchronisation iOS invalide échoue sans acquitter silencieusement les fiches rejetées.

## Réactivité du compagnon réseau

Une dépendance `hybrid.js` manquait dans les ressources servies : le chargement du module principal pouvait échouer avant l’installation des événements et de l’appairage. Elle est désormais servie et un bootstrap affiche une récupération explicite en cas d’échec de démarrage. Un jeton mémorisé valide reste connecté ; un rejet confirmé par `/auth/check` réaffiche l’appairage. Une coupure de Wi-Fi ne supprime pas le jeton.

Les conversations commencent avec 120 messages visibles et permettent de charger les précédents. Les rendus du streaming sont regroupés, les bulles inchangées et les détails ouverts sont conservés, et la lecture ne défile plus de force. La messagerie regroupe les accusés de lecture et les mises à jour de listes. Les requêtes ont un délai maximal et les rafraîchissements ne se chevauchent plus. La mise en arrière-plan suspend les rendus et ferme la socket ; le retour reprend une seule connexion. Le serveur ne garde plus le verrou du snapshot pendant les envois réseau et tolère un client en retard sans boucle de reconnexion. Les événements du coffre sont adressés au profil appairé, y compris si un autre profil est actif sur le Mac. Côté iOS, les notifications locales sont livrées sur le thread principal après libération du verrou du coffre pour éviter une relecture bloquante.

Les feuilles et leurs fonds sont au-dessus de Messages, avec des zones tactiles d’au moins 44 px. Les harnais `__preview-companion-performance.html` et `vault/__preview-vault.html` ne manipulent que des données fictives. Vérifications : streaming simulé sur 600 messages, taps des réglages et du coffre, appairage sur jeton expiré, récupération après échec d’initialisation, format 390 × 844, tests JS/Rust et build iOS Simulator sans signature. Aucun test sur un iPhone physique n’a été effectué.

### Données connectées : applications et sandboxs

La vue « Applications & sandboxs » du coffre expose l’index unifié de Lumen : notes, agenda, contacts, tâches, courriels, bases, corpus, états des applications et fichiers de sandbox indexés. Navigation par source, recherche dans le contenu et le chemin, pages de 60 résultats, aperçu et métadonnées d’origine. Les données restent dans leur stockage d’origine ; cette vue est en lecture seule et leur modification se fait dans l’application correspondante. Les sources exclues de l’index restent exclues. Ce catalogue n’est pas une copie exhaustive des fichiers bruts et ne migre pas les stockages des applications.

Les commandes `vault_sources` et `vault_source_get` sont disponibles dans l’application et dans l’API authentifiée du compagnon. Elles utilisent le profil de l’appareil appairé et les périmètres déjà définis par l’index. Les collections privées ne sont pas ajoutées à ce catalogue. Les accès aux fiches utilisent l’identifiant exact, sans rapprochement automatique vers une autre fiche.

Régression du compagnon : cinq colonnes dans la barre supérieure, boutons tactiles de 44 px sans découpage, repli de la barre d’outils si nécessaire. Le mode Messagerie impose une racine plein écran et masque les éléments du mode classique ; sa fermeture les restaure.

La section « Fichiers originaux » complète l’index avec un parcours direct des états d’applications (`app-state`), des magasins des apps intégrées et des sandboxs du profil connecté. Les dossiers se parcourent par pages de 60, les objets JSON peuvent se déplier et les fichiers texte ont un aperçu plafonné à 256 Ko. Les fichiers binaires restent visibles avec leur taille. Ce parcours utilisateur inclut les fichiers non indexés pour l’IA et ne change pas ses autorisations. Aucune copie des fichiers ni migration destructive. Le navigateur réseau et le compagnon iOS utilisent les mêmes commandes authentifiées. Le profil du compagnon détermine ses sandboxs ; un chemin absolu, `..` ou un lien symbolique sortant de la racine est refusé.

### Navigation par le harness des agents

Trois outils natifs en lecture sont proposés dans le groupe Coffre et dans Studio Nodal : `vault_overview` (collections, droits, sources et parcours conseillé), `vault_sources` (parcours/recherche par source, pages de 60 et aperçus courts), `vault_source_get` (lecture exacte d’une donnée connectée). Les agents peuvent les activer dans leur sélection d’outils ; le harness fournit leurs schémas et les exécute par la même voie que les autres outils natifs. Le chat expose également ces outils. Les collections utilisent ensuite `vault_query` et `vault_get`, avec `vault_set`/`vault_append` uniquement lorsqu’un droit d’écriture existe. L’explorateur de fichiers originaux destiné à l’utilisateur n’est pas exposé par ces outils : les fichiers exclus de l’index IA ne deviennent pas lisibles par un agent.
