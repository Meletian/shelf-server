const CACHE = "shelf-web-shell-v35-selfhost";
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/app/", "/app/manifest.webmanifest", "/app/icon-192.png"])));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || ['/api/','/v1/','/oauth/','/.well-known/'].some(prefix=>url.pathname.startsWith(prefix))) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => (await caches.open(CACHE)).match(url.pathname.startsWith('/app')?'/app/':'/app/')));
    return;
  }
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && ["script", "style", "image", "manifest"].includes(request.destination))
      cache.put(request, response.clone());
    return response;
  }));
});
