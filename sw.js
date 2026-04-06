const SW_VERSION = "2026-04-04-1";
const CACHE_PREFIX = "tilmelding-pwa-";
const CURRENT_CACHE = `${CACHE_PREFIX}${SW_VERSION}`;

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheKeys = await caches.keys();

    await Promise.all(
      cacheKeys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CURRENT_CACHE)
        .map((key) => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

/*
  Bevidst ingen fetch-handler.

  Det betyder:
  - index.html caches ikke af service worker
  - app.js caches ikke af service worker
  - Supabase/auth requests caches ikke af service worker
  - browseren går direkte på netværket som normalt

  Resultat:
  PWA kan installeres, men login-flowet forbliver så urørt som muligt.
*/
