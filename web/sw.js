// Minimal offline cache for the app shell (network first, cache fallback).
const CACHE = 'cameraview-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'player.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  // Only handle this site's own files; never touch gateway/API traffic.
  if (ev.request.method !== 'GET' || url.origin !== self.location.origin) return;
  ev.respondWith(
    fetch(ev.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(ev.request, copy));
        return res;
      })
      .catch(() => caches.match(ev.request)),
  );
});
