// Service worker minimal : rend l'application installable (PWA).
// Aucune mise en cache des données : le journal et les séances viennent toujours du réseau,
// et aucune donnée de santé n'est stockée hors ligne.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
