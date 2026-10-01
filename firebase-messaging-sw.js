// firebase-messaging-sw.js — push notifications + offline app shell.
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA5jR_KvDtN52sIUQiYffXL_1pcoN5vNpk",
  authDomain: "rp-housing-society.firebaseapp.com",
  projectId: "rp-housing-society",
  storageBucket: "rp-housing-society.firebasestorage.app",
  messagingSenderId: "964175352040",
  appId: "1:964175352040:web:a5aadfe8bf9a6d53af395d"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: 'icon-192.png'
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

// --- OFFLINE APP SHELL ---
// index.html: network first (fresh version whenever online), cached copy when
// offline or the network is too slow. Static assets and CDN libraries: cached
// copy first, refreshed in the background. Firebase/Google API calls are never
// cached (the Firestore SDK has its own offline store).
const SHELL_CACHE = 'rphs-shell-v2';
const SHELL_TIMEOUT_MS = 6000;
const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  './logo.png'
];
const CACHED_HOSTS = ['www.gstatic.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const NEVER_CACHE_HOSTS = ['firestore.googleapis.com', 'identitytoolkit.googleapis.com', 'securetoken.googleapis.com', 'fcmregistrations.googleapis.com', 'firebaseinstallations.googleapis.com', 'www.googleapis.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => Promise.all(SHELL_URLS.map(u => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('rphs-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  const path = url.pathname;
  return path.endsWith('/') || path.endsWith('/index.html');
}

function networkFirst(request) {
  return caches.open(SHELL_CACHE).then(cache => {
    // no-cache: always ask the server, so a new release shows on the next open
    // instead of after GitHub Pages' 10-minute browser cache runs out.
    const fromNetwork = fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    });
    fromNetwork.catch(() => {});
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), SHELL_TIMEOUT_MS));
    return Promise.race([fromNetwork, timeout])
      .catch(() => cache.match(request)
        .then(hit => hit || (isShellRequest(new URL(request.url)) ? cache.match('./index.html') : undefined))
        .then(hit => hit || fromNetwork));
  });
}

function staleWhileRevalidate(request) {
  return caches.open(SHELL_CACHE).then(cache =>
    cache.match(request).then(hit => {
      const refresh = fetch(request).then(res => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
        return res;
      }).catch(() => hit);
      return hit || refresh;
    })
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (NEVER_CACHE_HOSTS.includes(url.hostname)) return;

  if (req.mode === 'navigate' || isShellRequest(url)) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (url.origin === self.location.origin || CACHED_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});
