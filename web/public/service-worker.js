const SHELL_CACHE = "verdantos-shell-v9";
const RUNTIME_CACHE = "verdantos-runtime-v9";

// Pages aren't precached: where operators sign in, they redirect to /login
// until then. They're cached as the operator visits them (handleNavigation).
// Never kept: /login, and /settings, which shows the operator's email.
const UNCACHED_PAGES = ["/login", "/settings"];

const PRECACHE_URLS = [
  "/manifest.webmanifest",
  "/images/alert-danger.webp",
  "/images/app-icon.svg",
  "/images/favicon.svg",
  "/images/favicon-48.png",
  "/images/dashboard-icon.svg?v=2",
  "/images/history-icon.svg?v=2",
  "/images/icon-192.png",
  "/images/icon-512.png",
  "/images/icon-maskable-512.png",
  "/images/apple-touch-icon.png",
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

// sent on sign-out so visited pages don't stay readable offline
self.addEventListener("message", (event) => {
  if (event.data === "clear-pages") {
    event.waitUntil(caches.delete(RUNTIME_CACHE));
  }
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

    // a redirect (to /login) would be cached under the page it came from
    const path = new URL(request.url).pathname;
    if (response.ok && !response.redirected && !UNCACHED_PAGES.includes(path)) {
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
