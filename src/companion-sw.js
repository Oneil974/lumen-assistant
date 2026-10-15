// Service worker du compagnon.
//
// Deux rôles, et seulement deux :
//   1. Rendre l'app installable sur l'écran d'accueil (iOS n'autorise le push
//      QUE pour une app installée) ;
//   2. Afficher les notifications poussées par le Mac et ouvrir l'app au clic.
//
// Il ne met RIEN en cache. Le compagnon n'a aucun sens hors ligne : tout son
// contenu vient du Mac par WebSocket. Un cache ne servirait qu'à afficher une
// coquille vide et à servir un jour du code périmé.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  const title = data.title || "Lumen";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/lumen-192.png",
      badge: "/icons/lumen-192.png",
      // Un même sujet remplace sa notification précédente : trois demandes
      // d'approbation successives ne doivent pas empiler trois bannières.
      tag: data.tag || title,
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // Une fenêtre déjà ouverte est reprise plutôt que dupliquée.
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
