"use strict";

// EC V3.1 — intentionally conservative PWA service worker.
// It never caches authenticated EC data, APIs, vouchers, consumption or speed-test traffic.
const CACHE_PREFIX = "razafi-client-pwa-";
const CACHE_NAME = `${CACHE_PREFIX}v3.1-offline-v1`;
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
  if (request.method !== "GET" || request.mode !== "navigate") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/espace-client/")) return;

  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match(OFFLINE_URL, { ignoreSearch: true });
      return cached || new Response("Connexion indisponible", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    })
  );
});
