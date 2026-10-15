# ir_send

Envoyer une commande infrarouge

## Description
Déclenche l'envoi d'une commande LIRC via un petit module émetteur DIY (LED IR +
transistor ou carte prête à l'emploi). Indiquez le nom du `remote` et de la
`command` configurés dans `/etc/lirc/lircd.conf`, puis la commande est envoyée
aussi souvent que demandé pour piloter télévisions, climatiseurs ou autres
appareils.

## Entrées
- **REMOTE**: input_value (String)
- **COMMAND**: input_value (String)
- **COUNT**: input_value (Number)

## Sortie
- Aucune
