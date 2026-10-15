# Politique de confidentialité — Lumen

_Dernière mise à jour : 2026._

Lumen est conçu selon le principe du **local-first**. Cette politique décrit
quelles données l'application traite et comment.

## Aucune collecte de données

Lumen **ne collecte, ne stocke et ne transmet aucune donnée personnelle** vers
nos serveurs. Nous n'avons aucun serveur. Aucun compte n'est requis.

## Traitement local (mode Ollama)

Lorsque vous utilisez Ollama, l'ensemble du traitement (modèle, inférence,
historique de conversation) se déroule **entièrement sur votre Mac**. Vos
messages ne quittent jamais votre appareil.

## Mode modèles d'Apple / Raccourcis (optionnel)

Si vous choisissez d'utiliser les modèles d'Apple via l'app Raccourcis de macOS,
le traitement des requêtes est assuré par Apple et soumis à la
[politique de confidentialité d'Apple](https://www.apple.com/legal/privacy/).
Lumen transmet uniquement le texte que vous saisissez au raccourci que vous
avez configuré.

## Données stockées localement

Les préférences (réglages d'apparence, configuration du Heartbeat, historique
des conversations, notifications) sont enregistrées **localement** sur votre
Mac (stockage local de l'application). Vous pouvez les effacer à tout moment
depuis l'application ou en désinstallant celle-ci.

## Réseau

Par défaut, Lumen privilégie les traitements locaux. Selon les fonctionnalités
que vous activez, Lumen peut contacter :

- votre instance **Ollama locale** (par défaut `http://localhost:11434`) ;
- l'app **Raccourcis** de macOS, si vous activez ce mode ;
- un fournisseur d'IA configuré par vous, par exemple une API compatible
  OpenAI, si vous renseignez une clé et une URL ;
- le réseau local, si vous activez le compagnon mobile ou des objets domotiques.

Les services réseau optionnels sont liés à votre configuration locale. Lumen ne
transmet pas vos données vers un serveur Lumen : nous n'avons aucun serveur.

## Contact

Pour toute question : **VOTRE-EMAIL@exemple.com**

Pour signaler une vulnérabilité : voir `SECURITY.md`.

---

_Lumen n'est pas affilié à Apple Inc._
