// Service worker minimal : met en cache la coquille de l'appli.
// Les données et images Atlas Academy passent par le cache HTTP normal.
const CACHE = "fgo-reader-v2";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./audio/choice-select.mp3"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Coquille de l'appli : réseau d'abord (pour récupérer les mises à jour),
  // cache en secours (utilisation hors ligne)
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match("./index.html")))
    );
  }
  // Tout le reste (API/CDN Atlas) : comportement réseau normal
});
