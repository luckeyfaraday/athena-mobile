/// <reference lib="webworker" />
// Athena Mobile service worker.
//
// Purpose: when the OS evicts the backgrounded PWA, returning to it forces a full
// reload. Without a cache that reload re-fetches index.html, the JS bundle, xterm,
// and icons over the network from the laptop — the visible "wait" on every return.
// This worker keeps an app-shell cache so the shell paints instantly from disk and
// only the live data/SSE has to revalidate.
//
// Strategy: stale-while-revalidate for same-origin GETs (navigation + hashed Vite
// assets) — serve the cached copy immediately, refresh it from the network in the
// background. The proxied Athena API and the SSE stream are never touched, so live
// control always hits the real backend.

const CACHE = "athena-shell-v1";

// Requests routed to Athena's backend/control servers (and the live SSE stream)
// must always go to the network — caching them would serve stale agent state.
const PASS_THROUGH = ["/athena-backend", "/athena-control"];

self.addEventListener("install", (event) => {
  // Activate this worker as soon as it finishes installing, without waiting for
  // every old tab to close — there is only ever one phone using this.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older worker versions, then take control of open clients
      // so the very next navigation is served by this worker.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (PASS_THROUGH.some((prefix) => url.pathname.startsWith(prefix))) return;

  event.respondWith(staleWhileRevalidate(request));
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      // Only cache complete, successful responses; an opaque/redirect/error
      // response would poison the shell on the next load.
      if (response.ok && response.status === 200) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  // Cached copy first for an instant paint; fall back to the network on a cache
  // miss (first ever load, or a newly-deployed hashed asset).
  const response = cached ?? (await network);
  if (response) return response;

  // Offline with nothing cached: for a navigation, serve the cached app shell so
  // the SPA still boots and can show its own connection error.
  if (request.mode === "navigate") {
    const shell = await cache.match("/index.html") ?? (await cache.match("/"));
    if (shell) return shell;
  }
  return Response.error();
}
