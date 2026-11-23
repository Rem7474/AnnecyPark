const CACHE_VERSION = /* __ANNECYPARK_CACHE_VERSION__ */ 'v2';
const STATIC_CACHE = `annecypark-static-${CACHE_VERSION}`;
const DATA_CACHE = 'annecypark-data-v2';
const VITE_PRECACHE_URLS = /* __ANNECYPARK_PRECACHE__ */ [];
const PRECACHE_URLS = [
  '/',
  '/favicon.ico',
  '/icons/favicon-48.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/site.webmanifest',
  ...VITE_PRECACHE_URLS
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => Promise.allSettled(
      PRECACHE_URLS.map((url) => cache.add(url))
    )).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((k) => k !== STATIC_CACHE && k !== DATA_CACHE)
        .map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstApi(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-AnnecyPark-Offline', '1');
      const body = await cached.blob();
      return new Response(body, {
        status: cached.status,
        statusText: cached.statusText,
        headers
      });
    }
    return new Response(
      JSON.stringify({ offline: true, error: 'Réseau indisponible et aucun relevé en cache.' }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-AnnecyPark-Offline': '1'
        }
      }
    );
  }
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const exactMatch = await cache.match(request);
    if (exactMatch) {
      return exactMatch;
    }
    const homeFallback = await cache.match('/');
    if (homeFallback) {
      return homeFallback;
    }
    return new Response('Hors ligne', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname === '/api/health' || url.pathname === '/sw.js') {
    return;
  }

  if (
    url.pathname.startsWith('/dist/')
    || url.pathname.startsWith('/icons/')
    || url.pathname === '/og-image.png'
    || url.pathname === '/favicon.ico'
    || url.pathname === '/site.webmanifest'
  ) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstApi(request));
    return;
  }

  if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirstNavigation(request));
  }
});
