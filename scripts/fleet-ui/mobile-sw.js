// Bump the version whenever a shell asset changes. Never persist fleet data.
const CACHE = 'ashlr-mobile-shell-v4';
const SHELL = ['/mobile', '/mobile.js', '/mobile-actions.js', '/mobile-session.js',
  '/session-panel.js', '/mobile.webmanifest', '/mobile-192.png', '/mobile-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('ashlr-mobile-shell-') && key !== CACHE)
    .map(key => caches.delete(key)))));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Everything outside the exact static allowlist uses the browser's network path.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin ||
      url.search || !SHELL.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async cache =>
    (await cache.match(event.request)) || fetch(event.request)));
});
