import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await fs.readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const origin = "https://athena.test";
const html = (text) => new Response(text, { headers: { "Content-Type": "text/html" } });

function harness(fetch, dev = false) {
  const handlers = {};
  const stores = new Map();
  const caches = {
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      const key = (request) => new URL(typeof request === "string" ? request : request.url, origin).href;
      return {
        async match(request) { return store.get(key(request))?.clone(); },
        async put(request, response) { store.set(key(request), response.clone()); },
      };
    },
  };
  vm.runInNewContext(source, {
    URL, Response, caches, fetch,
    self: {
      location: new URL(`/sw.js${dev ? "?dev=1" : ""}`, origin),
      addEventListener: (name, handler) => { handlers[name] = handler; },
      clients: { claim: async () => {} },
    },
  });
  return {
    caches, handlers,
    async request(path, mode = "navigate") {
      let response;
      const pending = [];
      handlers.fetch({
        request: { url: new URL(path, origin).href, mode, method: "GET" },
        respondWith: (result) => { response = result; },
        waitUntil: (result) => pending.push(result),
      });
      await Promise.all(pending);
      return response;
    },
  };
}

test("online navigation replaces a cached shell from an older build", async () => {
  const worker = harness(async () => html("new build"));
  const cache = await worker.caches.open("athena-shell-v2");
  await cache.put("/", html("old build"));
  assert.equal(await (await worker.request("/")).text(), "new build");
  assert.equal(await (await cache.match("/")).text(), "new build");
});

test("offline navigation and notification deep links reuse the cached shell", async () => {
  const worker = harness(async () => { throw new Error("offline"); });
  const cache = await worker.caches.open("athena-shell-v2");
  await cache.put("/", html("offline shell"));
  assert.equal(await (await worker.request("/")).text(), "offline shell");
  assert.equal(await (await worker.request("/?terminal=t1")).text(), "offline shell");
});

test("a cached HTML response cannot stand in for a JavaScript asset", async () => {
  const worker = harness(async () => new Response("// working", { headers: { "Content-Type": "text/javascript" } }));
  const cache = await worker.caches.open("athena-shell-v2");
  await cache.put("/assets/app.js", html("poisoned"));
  assert.equal(await (await worker.request("/assets/app.js", "cors")).text(), "// working");
});

test("missing assets and HTML fallbacks never enter the cache", async () => {
  for (const response of [html("fallback"), new Response("missing", { status: 404 })]) {
    const worker = harness(async () => response.clone());
    await worker.request("/assets/old.js", "cors");
    const cache = await worker.caches.open("athena-shell-v2");
    assert.equal(await cache.match("/assets/old.js"), undefined);
  }
});

test("valid cached hashed assets work without a network fetch", async () => {
  const worker = harness(() => { assert.fail("unexpected network request"); });
  const cache = await worker.caches.open("athena-shell-v2");
  await cache.put("/assets/app.js", new Response("// cached", { headers: { "Content-Type": "text/javascript" } }));
  assert.equal(await (await worker.request("/assets/app.js", "cors")).text(), "// cached");
});

test("activation removes the broken v1 cache without deleting unrelated caches", async () => {
  const worker = harness(() => {});
  for (const name of ["athena-shell-v1", "athena-shell-v2", "other-app"]) await worker.caches.open(name);
  let activation;
  worker.handlers.activate({ waitUntil: (promise) => { activation = promise; } });
  await activation;
  assert.deepEqual(await worker.caches.keys(), ["athena-shell-v2", "other-app"]);
});

test("API requests and dev modules remain network-only", async () => {
  const worker = harness(() => { assert.fail("worker must not handle API requests"); });
  for (const path of ["/athena-backend/health", "/athena-control/events", "/athena-push/key"]) {
    assert.equal(await worker.request(path, "cors"), undefined);
  }
  assert.equal(await harness(() => {}, true).request("/src/main.tsx", "cors"), undefined);
});
