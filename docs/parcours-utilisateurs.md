# Trois parcours d'apprentissage — proposition

*Document de proposition (non implémenté). Objectif : donner à l'utilisateur une
porte d'entrée qui corresponde à son niveau, au lieu de lui présenter Lumen
comme un seul produit à 40 fonctionnalités.*

## Le problème

Lumen expose aujourd'hui, dès la première ouverture, la barre, le bureau, les
apps, les agents, Fluxo, la sandbox, le heartbeat, le controller. Tout est
documenté, mais tout est au même niveau : la documentation liste les modules
(un par page), pas les usages. Un débutant ne sait pas par quoi commencer ; un
confirmé ne sait pas ce qu'il n'a pas encore trouvé.

La correction n'est pas d'ajouter du texte, c'est de **hiérarchiser** : trois
parcours, chacun avec une promesse en une phrase, trois à cinq gestes concrets,
et une seule invitation à passer au niveau suivant.

---

## Niveau 1 — Débutant : « une barre, une réponse »

**Promesse :** *Tapez, appuyez sur Entrée, Lumen répond. Rien d'autre à
comprendre.*

Périmètre : la barre de chat principale et le choix du modèle. Point.

Ce qu'il faut expliquer, dans cet ordre :

1. **Ouvrir la barre** — le raccourci clavier, et le fait qu'elle se referme
   toute seule. C'est le seul geste à mémoriser.
2. **Poser une question** — une phrase en langage naturel, pas une commande.
3. **Choisir son modèle** — la seule décision réellement structurante du niveau
   1. Elle mérite une explication en trois lignes, pas un tableau :
   - *local* = gratuit, privé, plus lent, il tourne sur votre machine ;
   - *API* = plus puissant, payant, **vos messages quittent la machine** ;
   - en cas de doute : rester en local.
4. **Changer d'avis** — où on rechange de modèle (Réglages ▸ IA), pour que le
   choix initial ne soit pas vécu comme définitif.

Ce qu'il ne faut *pas* montrer à ce niveau : les modes, le mode Action, les
agents, le bureau. Ils n'ont pas de sens tant que la boucle
« question → réponse » n'est pas acquise.

**Changements proposés**
- Une page « Premiers pas » en tête du sommaire de la documentation, avant
  « Vue d'ensemble », rédigée en gestes (« tapez… », « appuyez… ») et non en
  concepts.
- L'écran de fin d'assistant se termine sur **un seul** appel à l'action :
  « Posez votre première question », pas sur une liste de modules.
- La visite guidée de la barre (`bar-tour.js`) s'arrête après 3 étapes en niveau
  débutant ; les étapes avancées sont proposées plus tard.

---

## Niveau 2 — Intermédiaire : « Lumen fait des choses pour vous »

**Promesse :** *La même barre, mais elle peut chercher, agir, se souvenir et
travailler pendant que vous faites autre chose.*

Périmètre : barre principale, modes de discussion, designer (Fluxo), heartbeat,
agents, apps de la barre, sandbox.

L'articulation à faire passer — et c'est elle qui manque aujourd'hui — est une
**progression en autonomie croissante** :

| Ce que vous voulez | L'outil | Qui déclenche |
|---|---|---|
| Une réponse différente (recherche, doc, action) | **les modes** | vous, à chaque message |
| Un enchaînement fiable, toujours identique | **le designer (Fluxo)** | vous, quand vous l'appelez |
| Le même enchaînement, tout seul, à heure fixe | **le heartbeat** | l'horloge |
| Une tâche floue, à découper et à mener à bien | **un agent** | vous, puis l'agent lui-même |

Quatre lignes qui répondent à la question que tout le monde se pose à ce
niveau : *« quelle différence entre un workflow, un heartbeat et un agent ? »*.
La réponse tient en un mot : **qui appuie sur le bouton.**

Les **apps** et la **sandbox** se présentent alors naturellement comme le
« où » : les apps sont ce que Lumen sait ouvrir et manipuler, la sandbox est
l'endroit où tout ce petit monde a le droit d'écrire — et le seul.

**Changements proposés**
- Une page « Faire faire » regroupant ce tableau, avec un lien vers chacune des
  pages existantes (modes / Fluxo / heartbeat / agents). Les pages actuelles ne
  bougent pas : on ajoute la carte, pas le territoire.
- Un premier exemple *de bout en bout* et unique, décliné aux quatre étages
  (par ex. « résumer mes notes de la semaine ») : le même besoin traité en mode,
  puis en workflow, puis en heartbeat, puis en agent. C'est la démonstration la
  plus économique de la différence entre les quatre.
- Dans le designer, un bandeau « à quoi sert un workflow » sur canevas vide, au
  lieu d'un canevas vide.

---

## Niveau 3 — Confirmé : « Lumen est un environnement »

**Promesse :** *Un poste de travail complet, pilotable de l'extérieur et
extensible.*

Périmètre : mode bureau (desktop/dock), agents avancés, applications,
Lumen Controller, designer & automatisations.

À ce niveau, l'utilisateur n'a plus besoin qu'on lui explique les
fonctionnalités — il a besoin qu'on lui explique **les jointures** :

- **Le mode bureau** n'est pas un thème : c'est le passage d'un lanceur à un
  système avec session, fenêtres, dock et apps persistantes. Le dire
  explicitement (aujourd'hui c'est une option de réglage parmi d'autres).
- **Les agents avancés** : skills auto-créés, orchestrateur et sous-agents,
  boucle persistante, garde-fous en tokens et en itérations. Ce qui manque
  n'est pas la description mais les **limites** : ce qu'un agent ne fera jamais
  sans validation, et où lire ce qu'il a fait (Journal LLM).
- **Le Controller** : ce qui pilote Lumen depuis l'extérieur (téléphone,
  Telegram, API HTTP locale, matériel). Une page unique « piloter Lumen à
  distance » remplacerait avantageusement les mentions dispersées.
- **Designer & automatisations** : bloc personnalisé, skill versionnée,
  intégration avec la sandbox et les tables. C'est le niveau où Fluxo cesse
  d'être un outil de démonstration pour devenir la couche d'extension.

**Changements proposés**
- Une page « Aller plus loin » qui liste les jointures ci-dessus, avec pour
  chacune la question à laquelle elle répond.
- Une section « limites et garde-fous » réellement visible : à ce niveau,
  savoir ce que le système *ne fait pas* vaut mieux qu'une fonctionnalité de
  plus.

---

## Mise en œuvre suggérée, par coût croissant

1. **Étiqueter l'existant.** Ajouter un badge *Débutant / Intermédiaire /
   Confirmé* sur chaque page du sommaire de la documentation. Coût quasi nul,
   bénéfice immédiat : le sommaire devient lisible.
2. **Trois pages de parcours.** Les trois sections ci-dessus, comme pages
   d'entrée qui renvoient vers les pages de modules existantes.
3. **Demander le niveau dans l'assistant.** Une question à la fin de
   l'installation (« Vous découvrez Lumen ? / Vous automatisez déjà ? / Vous
   voulez tout »), qui règle deux choses : la longueur de la visite guidée et
   la page ouverte par défaut dans la documentation. Réversible dans les
   Réglages, jamais bloquant : c'est un raccourci, pas une restriction.
