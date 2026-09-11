"use strict";

// Admin PWA V1.1 — deliberately conservative service worker.
// It NEVER caches authenticated Admin pages, APIs, revenue, clients, billing,
// pools, users, audit data, Assistant data, or any other business response.
const CACHE_PREFIX = "razafi-admin-pwa-";
const CACHE_NAME = `${CACHE_PREFIX}v1.1-offline-v1`;
const OFFLINE_URL = "/admin/offline.html";
const OFFLINE_ASSETS = [
  OFFLINE_URL,
  "/admin/offline.css",
  "/admin/assets/pwa/icon-192.png",
  "/admin/assets/pwa/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(OFFLINE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Keep this worker strictly inside the Admin PWA. In particular, do not
  // intercept /api/admin/*, /api/owner/*, /espace-client/* or external login.
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/admin/")) return;

  // Admin navigations are always network-only. If the network is unavailable,
  // return a dedicated static offline screen instead of stale Admin data.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-store" }).catch(async () => {
        const cached = await caches.match(OFFLINE_URL, { ignoreSearch: true });
        return cached || new Response("Connexion indisponible", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      })
    );
    return;
  }

  // Serve ONLY the dedicated offline shell assets from cache. All normal Admin
  // CSS/JS/images continue to come from the network and are never app-cached.
  if (OFFLINE_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true })
        .then((cached) => cached || fetch(request))
    );
  }
});
