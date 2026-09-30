'use strict';

// Everything is served cache-first and refreshed in the background, so the app
// opens instantly and offline; a new version shows up on the launch after next.
const CACHE = 'goatmire-v1';
const SCHEDULE = 'data/schedule.json';
const SHELL = [
  './',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'img/goatmire.jpg',
  'icons/icon-32.png',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

const photosOf = (schedule) => Object.values(schedule.speakers).map((s) => s.photo).filter(Boolean);

async function cachePhotos(cache, schedule) {
  await Promise.all(
    photosOf(schedule).map(async (url) => {
      if (!(await cache.match(url))) await cache.add(url).catch(() => {});
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll([...SHELL, SCHEDULE]);
      await cachePhotos(cache, await (await cache.match(SCHEDULE)).json());
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

async function refresh(cache, request, cached) {
  const response = await fetch(request, { cache: 'no-cache' });
  if (!response.ok) return response;
  const isSchedule = new URL(request.url).pathname.endsWith(SCHEDULE);
  const before = isSchedule && cached ? await cached.clone().text() : null;
  await cache.put(request, response.clone());
  if (isSchedule) {
    const text = await response.clone().text();
    if (text !== before) {
      await cachePhotos(cache, JSON.parse(text));
      if (before !== null) {
        const clients = await self.clients.matchAll();
        clients.forEach((client) => client.postMessage('schedule-updated'));
      }
    }
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // ?now=… and friends must still hit the cached page
      const key = request.mode === 'navigate' ? './' : request;
      const cached = await cache.match(key, { ignoreSearch: true });
      const fresh = refresh(cache, key === './' ? new Request('./') : request, cached);
      if (cached) {
        event.waitUntil(fresh.catch(() => {}));
        return cached;
      }
      return fresh;
    })(),
  );
});
