# device_log_metric

Envoie une métrique vers la plateforme.

## Description
Publie une valeur (température, CPU, stockage, etc.) visible dans la section Logs des devices.

## Entrées
- **URL** : input_value – URL de la plateforme.
- **DEVICE** : input_value – ID du device configuré.
- **KIND** : field_dropdown – type de métrique (metric, temperature, cpu, storage).
- **LABEL** : input_value – nom de la métrique.
- **VALUE** : input_value – valeur à envoyer.
- **UNIT** : input_value – unité (ex: `°C`, `%`, `GB`).

## Sortie
- Aucune
