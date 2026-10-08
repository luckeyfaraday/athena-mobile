/// <reference lib="webworker" />
// Athena Mobile service worker.
//
// Purpose: when the OS evicts the backgrounded PWA, returning to it forces a full
// reload. Without a cache that reload re-fetches index.html, the JS bundle, xterm,
// and icons over the network from the laptop — the visible "wait" on every return.
// This worker keeps an app-shell cache so the shell paints instantly from disk and
// only the live data/SSE has to revalidate.
//
// Navigations use the network first so an old shell cannot reference assets
// removed by a deployment, but fall back to the cached shell after a few
// seconds: an unreachable host usually hangs rather than refusing, and the app
// must not sit on a blank screen waiting for it. Hashed assets (/assets/) never
// change, so they are cache-first; other files (manifest, icons) are
// network-first with the cache as the offline fallback. The proxied Athena API
// and SSE stream always use the network.

const CACHE = "athena-shell-v2";
const NAVIGATION_TIMEOUT_MS = 3000;

// When registered against the HTTPS dev server (so push can be tested), the
// worker must not cache Vite's module graph — that would serve stale code across
// edits. The registrant passes ?dev=1; in that mode fetches pass straight to the
// network and only the push handlers below are active.
const DEV = new URL(self.location.href).searchParams.get("dev") === "1";

// Requests routed to Athena's backend/control/push servers (and the live SSE
// stream) must always go to the network — caching them would serve stale agent
// state.
const PASS_THROUGH = ["/athena-backend", "/athena-control", "/athena-remote", "/athena-push"];

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
      await Promise.all(names.filter((name) => name.startsWith("athena-shell-") && name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (DEV) return; // dev: never cache; let the network/Vite serve everything.
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (PASS_THROUGH.some((prefix) => url.pathname.startsWith(prefix))) return;

  const { response, settled } = appResponse(request);
  event.respondWith(response);
  // Keeps the worker alive until the network answer is cached, even when the
  // cached shell was served first.
  event.waitUntil(settled);
});

// A push arrives even when the PWA is closed; show the agent-attention alert.
self.addEventListener("push", (event) => {
  const payload = safeJson(event.data);
  const title = payload.title || "Athena Mobile";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      // tag = terminal id, so repeated alerts for one agent collapse in the tray.
      tag: payload.tag || "athena",
      renotify: true,
      icon: "/athena-icon-192.png",
      badge: "/athena-icon-192.png",
      data: { url: payload.url || "/" },
    }),
  );
});

// Tapping the notification focuses an open app window (deep-linking via a
// postMessage the app reads) or opens a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        if ("focus" in client) {
          const focused = await client.focus();
          focused.postMessage({ type: "athena-notification-click", url: targetUrl });
          return focused;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })(),
  );
});

function safeJson(data) {
  if (!data) return {};
  try {
    return data.json();
  } catch {
    return {};
  }
}

function validResponse(request, response) {
  if (response.status !== 200 || response.redirected) return false;
  const type = response.headers.get("Content-Type") || "";
  const pathname = new URL(request.url).pathname;
  if (request.mode === "navigate") return type.includes("text/html");
  if (pathname.endsWith(".js")) return /(?:java|ecma)script/i.test(type);
  if (pathname.endsWith(".css")) return type.includes("text/css");
  // Never store the SPA fallback as an icon, script, or other static asset.
  return !type.includes("text/html");
}

function appResponse(request) {
  const navigation = request.mode === "navigate";
  const hashed = new URL(request.url).pathname.startsWith("/assets/");
  let network = null;
  const response = (async () => {
    const cache = await caches.open(CACHE);
    // Any navigation (a notification deep link included) can use the app shell.
    const hit = (await cache.match(request)) ?? (navigation ? (await cache.match("/")) ?? (await cache.match("/index.html")) : undefined);
    const cached = hit && validResponse(request, hit) ? hit : null;
    if (hashed && cached) return cached;

    network = fetch(request, navigation ? { cache: "no-store" } : undefined).then(async (fresh) => {
      // A full cache or private browsing must not discard a working response.
      if (validResponse(request, fresh)) {
        try { await cache.put(request, fresh.clone()); } catch { /* best effort */ }
      }
      return fresh;
    });

    if (navigation && cached) {
      const timedOut = new Promise((resolve) => setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS));
      const first = await Promise.race([network.catch(() => null), timedOut]);
      return first && validResponse(request, first) ? first : cached;
    }
    try {
      const fresh = await network;
      if (!navigation || validResponse(request, fresh)) return fresh;
    } catch { /* offline: use the cached copy below */ }
    return cached ?? Response.error();
  })();
  const settled = response.then(() => network?.catch(() => undefined), () => undefined);
  return { response, settled };
}
