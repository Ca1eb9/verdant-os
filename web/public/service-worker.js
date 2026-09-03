const SHELL_CACHE = "verdantos-shell-v2";
const RUNTIME_CACHE = "verdantos-runtime-v2";

const PRECACHE_URLS = [
  "/",
  "/history",
  "/alerts",
  "/config",
  "/manifest.webmanifest",
  "/images/sprout-logo.webp",
  "/images/alert-danger.webp",
  "/images/app-icon.svg",
  "/images/mask-icon.svg",
  "/images/air-icon.svg",
  "/images/water-icon.svg",
  "/images/light-icon.svg",
  "/images/dashboard-icon.svg",
  "/images/history-icon.svg",
  "/images/config-icon.svg",
  "/images/icon-192.png",
  "/images/icon-512.png",
  "/images/icon-maskable-512.png",
  "/images/apple-touch-icon.png",
  "/images/splash-screen.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => ![SHELL_CACHE, RUNTIME_CACHE].includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);

  if (event.request.mode === "navigate") {
    event.respondWith(handleNavigation(event.request));
    return;
  }

  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/_next/static/") ||
      url.pathname.startsWith("/images/") ||
      url.pathname === "/manifest.webmanifest")
  ) {
    event.respondWith(staleWhileRevalidate(event.request));
  }
});

async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(RUNTIME_CACHE);

    if (response.ok) {
      cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    const cachedResponse = await caches.match(request);

    if (cachedResponse) {
      return cachedResponse;
    }

    return caches.match("/");
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cachedResponse = await cache.match(request);

  try {
    const networkResponse = await fetch(request);

    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }

    return cachedResponse ?? networkResponse;
  } catch (error) {
    return cachedResponse ?? caches.match("/");
  }
}
