# La démo de 90 secondes

Une seule chose à prouver : **un travail réel traverse Lumen de bout en bout,
sans réseau.** Pas un tour des vingt-huit applications — une chaîne qui marche.

Quiconque regarde doit repartir avec une phrase en tête : *« ça tourne sur sa
machine, et les apps se parlent »*.

---

## Préparer (hors caméra)

- **Couper le Wi-Fi.** C'est l'argument entier de Lumen. On le montre, on ne le
  dit pas : la barre du système sans réseau est plus convaincante que trois
  phrases sur la vie privée.
- Modèle local chargé et chaud (une requête à blanc avant de lancer
  l'enregistrement — le premier chargement prend dix secondes et casse le
  rythme).
- Un profil propre : pas de notes de test, pas de fenêtres ouvertes.
- Une source de données prête, ordinaire et lisible : un CSV de dépenses, un
  relevé, une liste — quelque chose que le spectateur reconnaît.

---

## Le déroulé

**0:00 — 0:10 · L'invocation**
Un bureau quelconque, rien à l'écran. `⌥ Espace`. La barre apparaît, l'orbe
s'anime. On tape une demande en langage courant : *« analyse mes dépenses du
mois »*.
→ *Ce qui est montré : Lumen est là avant qu'on ne le cherche.*

**0:10 — 0:30 · L'agent travaille**
Le modèle appelle des outils. On voit passer les étapes — lecture du fichier,
requête sur la table, calcul. On laisse voir le Wi-Fi coupé, une seconde, sans
commentaire.
→ *Ce qui est montré : il ne répond pas, il agit — et localement.*

**0:30 — 0:50 · Le résultat devient un objet**
Un tableau apparaît. Clic sur **Envoyer vers…** → *Calc*. Le tableau s'ouvre
dans le tableur, vivant, éditable.
→ *Ce qui est montré : le tissu conjonctif. C'est LE moment de la démo — le
seul que les concurrents ne peuvent pas copier avec un wrapper d'API.*

**0:50 — 1:10 · La chaîne continue**
Depuis Calc, un graphique. **Envoyer vers…** → *Opus*. Un document propre se
compose autour du graphique. Deux phrases dictées à la voix pour le commenter.
→ *Ce qui est montré : la chaîne ne casse jamais — pas d'export, pas de
copier-coller, pas de format intermédiaire.*

**1:10 — 1:25 · Ça se répète tout seul**
Le workflow Fluxo qui vient d'être parcouru est enregistré comme
automatisation, planifiée au premier du mois.
→ *Ce qui est montré : ce n'était pas une démo à usage unique.*

**1:25 — 1:30 · La sortie**
Sur le titre : « Tout ça sur votre machine. »

---

## Ce qu'il ne faut PAS faire

- **Montrer le launcher d'applications.** Vingt-huit icônes disent « collection
  de gadgets ». Une chaîne qui aboutit dit « système ».
- **Expliquer l'architecture.** Personne ne veut savoir qu'il y a du SQLite
  embarqué avant d'avoir vu ce que ça fait.
- **Accélérer la vidéo.** Si le modèle local est trop lent pour être filmé en
  temps réel, c'est une information — traitez-la comme un bug, pas comme un
  problème de montage.
- **Ajouter une musique de fond énergique.** Le silence rend l'absence de
  réseau plus tangible.

---

## Rendu

Les vidéos de présentation sont assemblées avec HyperFrames
(`presentation/render.sh`), depuis des copies `export-*` — **resynchroniser les
HTML racine avant de rendre**, sinon on rend l'ancienne version.
