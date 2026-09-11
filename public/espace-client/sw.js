"use strict";

// EC V3.3.1 — conservative PWA service worker with resilient offline shell assets.
// It never caches authenticated EC data, APIs, vouchers, consumption or speed-test traffic.
const CACHE_PREFIX = "razafi-client-pwa-";
const CACHE_NAME = `${CACHE_PREFIX}v3.3.1-offline-v2`;
const OFFLINE_URL = "/espace-client/offline.html";
const OFFLINE_ASSETS = [
  OFFLINE_URL,
  "/espace-client/offline.css",
  "/espace-client/assets/pwa/icon-192.png",
  "/espace-client/assets/pwa/icon-512.png"
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
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/espace-client/")) return;

  // Navigation remains network-first. If the EC cannot be reached, show only
  // the dedicated static offline screen — never cached client/session data.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(OFFLINE_URL, { ignoreSearch: true });
        return cached || new Response("Connexion indisponible", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      })
    );
    return;
  }

  // The offline screen references its stylesheet and icon as separate requests.
  // Serve ONLY these pre-cached shell assets while offline. This fixes the raw
  // unstyled fallback without caching any API, voucher, consumption, branding,
  // speed-test or authenticated EC response.
  if (OFFLINE_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request, { ignoreSearch: true })
        .then((cached) => cached || fetch(request))
    );
  }
});
