# Préparation open source — 15 octobre 2026

## Choix et changements

- Code original et documentation sous GPL-3.0-or-later, selon le choix du
  mainteneur de conserver libres les versions dérivées distribuées. Texte
  complet dans COPYING et dans le noyau. L'ancien écran d'acceptation
  propriétaire est remplacé par une consultation de la licence libre.
- Inventaires npm et Cargo et textes disponibles collectés dans `src/legal/`.
  La collecte signale les licences non déclarées et les textes absents.
- Export géré `public-source/`, CLI et onglet Code source de Sync Hub.
  La configuration APFS et les machines privées restent dans les sources de
  travail ; le miroir reçoit un lancement portable et des cibles vides.
- Packs graphiques Gaming/Cosy et MetroCity exclus du miroir faute de
  preuve locale autorisant leur redistribution source.
- README de build réécrit par plateforme et capacités rapprochées de la
  documentation intégrée. Vue d'ensemble intégrée modernisée ; nouvelle page
  Compiler et contribuer. Le catalogue courant comporte 43 paquets.

## Sécurité

Tiberius 0.13.0 remplace l'ancienne chaîne SQL Server. Les dépendances Rustls
et Quinn du bureau et du serveur sont corrigées ; `object` 0.39.1 est adapté
localement pour utiliser ruzstd 0.9.1 en attendant une prise en charge amont
par espflash. Les fichiers de licence et la provenance du patch sont conservés.
Le transport mail choisit explicitement le fournisseur cryptographique ring,
car Tiberius active aussi aws-lc-rs.

Au moment de cette vérification : zéro vulnérabilité connue dans les audits
Rust du bureau, du serveur autonome et de Sync Hub. Les contrôles Cargo
bans/licences/sources passent. L'audit npm conserve deux alertes modérées
ExcelJS/uuid, acceptées dans le suivi R-009 ; l'audit global reste donc en échec.
Les outils d'audit absents font désormais échouer le contrôle plutôt que
produire un résultat implicitement vert.

## Vérifications

- 209 tests JavaScript passent avec les ports loopback autorisés.
- 258 tests Rust du bureau passent, 4 tests existants restent ignorés.
- 37 tests du serveur autonome et ses doctests passent.
- 14/14 scénarios du banc d'orchestration scripté passent.
- 5 tests de sécurité de l'export passent : aperçu, répétition, suppression
  contrôlée des fichiers périmés, préservation des modifications locales et
  de Git, refus des liens et des chemins traversants, arrêt sur secret probable.
- Depuis le miroir propre : dépendances réinstallées, 209 tests JS et
  258 tests Rust réussis ; construction frontend et 43 paquets du catalogue
  vérifiés avec Node.js 24.19.0. Le minimum déclaré est Node.js 22.12.
- Construction frontend et 43 paquets du catalogue vérifiés. Les empreintes
  des paquets ignorent désormais aussi les métadonnées AppleDouble que le ZIP
  écarte, pour éviter des révisions fictives sur exFAT.
- Endpoint Sync Hub essayé avec le client Flask ; origine étrangère refusée.
  Nouvel onglet et aperçu vérifiés dans le navigateur.
- Pooling EmbeddingGemma manquant corrigé selon les fiches officielles Google ;
  le test de catalogue le signalait. Test d'orbe adapté à l'avatar Framboise
  ajouté et test serveur de routage mis à jour pour conserver les leases.

## Limites avant annonce publique

Le contact privé de signalement de sécurité est
[lumenassistantsecurity@gmail.com](mailto:lumenassistantsecurity@gmail.com),
également indiqué dans `SECURITY.md`.
`buffers@0.1.1` ne déclare pas sa licence dans l'archive npm ; d'autres paquets
ne joignent pas de texte de licence racine. Les inventaires documentent ces
cas sans en déduire une autorisation de redistribution. Les moteurs natifs,
modèles et voix restent à examiner pour chaque archive binaire diffusée.

La connexion réelle à SQL Server n'a pas été essayée : Tiberius 0.13 requiert
TLS par défaut et ajoute des timeouts ; vérifier les serveurs et certificats
utilisés avant une release. Les essais Windows/Linux, appareils, signature,
updater et installateurs ne sont pas certifiés par ces tests macOS.

Le miroir est prêt pour une publication de sources dans le dépôt existant `Oneil974/lumen-assistant`. Cela ne crée pas de nouvelle release binaire. Les validations restent celles indiquées ci-dessus ; aucune certification de tous les installateurs n’est déduite de la publication du code.
