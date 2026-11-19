/* Service worker: permite usar la app sin conexión una vez visitada por HTTPS.
 * IMPORTANTE: sube CACHE_VERSION cada vez que cambies index.html, sync.js,
 * algún archivo de vendor/ o las páginas legales. */
const CACHE_VERSION = 'gestor-pagos-v3';
const BASE = new URL('./', self.registration.scope).pathname;
const RECURSOS = [
  './',
  './index.html',
  './sync.js',
  './manifest.webmanifest',
  './icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './legal/privacidad.html',
  './legal/terminos.html',
  './legal/descargo.html',
  './vendor/fflate.min.js',
  './vendor/xlsx.full.min.js',
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  './vendor/chart.umd.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.allSettled(RECURSOS.map((r) => cache.add(r))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // NUNCA cachear la API: son respuestas por usuario y cambian en cada guardado.
  // Dejar pasar la petición sin interceptarla (ni siquiera en modo offline),
  // para que un /api/health en caché no haga creer que hay servidor cuando
  // la app se sirve de forma estática o el backend está caído.
  if (url.pathname.startsWith(BASE + 'api/') || /\/api\//.test(url.pathname)) return;

  // Navegación: red primero, con respaldo en caché.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((resp) => {
        if (resp.ok) caches.open(CACHE_VERSION).then((c) => c.put('./index.html', resp.clone()));
        return resp;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Resto de recursos locales: caché primero.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((resp) => {
      if (resp.ok) caches.open(CACHE_VERSION).then((c) => c.put(req, resp.clone()));
      return resp;
    }))
  );
});
