// App « Matin » : la vue du matin ouverte à la demande, dans sa propre fenêtre.
// Tout le rendu vit dans sandbox/morning.js, partagé avec l'écran affiché
// automatiquement par le bureau au premier démarrage du jour.
import { showMorning } from "../sandbox/morning.js";

showMorning({
  embedded: true,
  // Paquet : `lumen.apps.open` (lib/appkit/guest.js) ; page servie par le
  // bureau lui-même (aperçu) : son lanceur.
  openApp: (id) => window.lumen?.apps?.open?.(id) ?? window.top?.LumenOpenApp?.(id),
});
