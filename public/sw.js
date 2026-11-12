// Keeps the app shell available offline; messages always come fresh from the network.
const CACHE = 'hon-v4';
const SHELL = ['/', '/app.css', '/app.js', '/icon.svg', '/wordmark.svg', '/manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/u/') || url.pathname.startsWith('/admin')) return;
  // Network first so updates show right away — but on a slow line, after 2.5 s use the saved copy instead of a blank screen.
  const net = fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; });
  const saved = () => caches.match(e.request).then((r) => r || (e.request.mode === 'navigate' ? caches.match('/') : undefined));
  e.respondWith(new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => saved().then((r) => { if (r && !done) { done = true; resolve(r); } }), 2500);
    net.then((r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } })
      .catch(() => saved().then((r) => { if (!done) { done = true; clearTimeout(timer); resolve(r || Response.error()); } }));
  }));
});
