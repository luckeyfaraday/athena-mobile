import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createJarvisProxy, isTailnetOrLoopbackHost, parseJarvisTarget } from "./jarvis-proxy.mjs";

test("the target must be plain http on loopback or Tailscale", () => {
  for (const ok of [
    "http://127.0.0.1:47821",
    "http://localhost:9000/",
    "http://100.64.0.1:47821",
    "http://100.127.255.254:47821",
    "http://[fd7a:115c:a1e0::1234]:47821",
    "http://[::1]:47821",
    "http://laptop.tail1234.ts.net:47821",
  ]) {
    assert.equal(parseJarvisTarget(ok).ok, true, ok);
  }
  for (const [refused, reason] of [
    ["https://100.64.0.1:47821", /http:\/\//],
    ["http://192.168.1.20:47821", /not loopback or a Tailscale address/],
    ["http://100.128.0.1:47821", /not loopback/],
    ["http://8.8.8.8", /not loopback/],
    ["http://[fd7a:115c:a1e1::1]:47821", /not loopback/],
    ["http://[::ffff:127.0.0.1]:47821", /not loopback/],
    ["http://ts.net.evil.example", /not loopback/],
    ["http://tail1234.ts.net", /not loopback/],
    ["http://token:x@100.64.0.1:47821", /ATHENA_JARVIS_TOKEN/],
    ["http://100.64.0.1:47821/?a=1", /query/],
    ["100.64.0.1:47821", /http:\/\//],
    ["not a url", /isn't a URL/],
  ]) {
    const parsed = parseJarvisTarget(refused);
    assert.equal(parsed.ok, false, refused);
    assert.match(parsed.reason, reason, refused);
  }
  assert.equal(isTailnetOrLoopbackHost("LAPTOP.Tail1234.TS.NET."), true);
  assert.equal(isTailnetOrLoopbackHost("[::]"), false);
});

test("unset or refused, the mount answers 404 not configured and says why at startup", async (t) => {
  const lines = [];
  const unset = createJarvisProxy({ env: {}, log: (line) => lines.push(line) });
  const refused = createJarvisProxy({ env: { ATHENA_JARVIS_TARGET: "http://203.0.113.9:47821" }, log: (line) => lines.push(line) });
  assert.equal(unset.target, null);
  assert.equal(refused.target, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ATHENA_JARVIS_TARGET refused: 203\.0\.113\.9 is not loopback.*\/athena-jarvis stays off/);
  for (const proxy of [unset, refused]) {
    const { server, base } = await mount(proxy);
    t.after(() => server.close());
    const response = await fetch(`${base}/jarvis`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not configured" });
  }
});

// A stand-in for the Athena that runs Jarvis: records what reached it, and
// can hold an event stream open, drop one, or go quiet.
async function fakeAthena() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/jarvis/events") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.write(`event: jarvis\ndata: ${JSON.stringify({ running: true })}\n\n`);
        return;
      }
      if (req.url === "/base/jarvis/events" || req.url === "/jarvis/events?drop=1") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: jarvis\ndata: {}\n\n");
        setTimeout(() => req.socket.destroy(), 50);
        return;
      }
      if (req.url === "/jarvis/ask") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Jarvis is not running", jarvis: { running: false } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jarvis: { running: true } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

async function mount(proxy) {
  const server = http.createServer((req, res) => {
    req.url = req.url.slice("/athena-jarvis".length) || "/";
    proxy.middleware(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}/athena-jarvis` };
}

async function setup(t, env = {}, options = {}) {
  const athena = await fakeAthena();
  const proxy = createJarvisProxy({ env: { ATHENA_JARVIS_TARGET: athena.url, ...env }, log: () => assert.fail("no warning"), ...options });
  const { server, base } = await mount(proxy);
  t.after(() => {
    server.closeAllConnections();
    server.close();
    athena.server.closeAllConnections();
    athena.server.close();
  });
  return { athena, base, proxy };
}

test("requests reach the target with its token and without browser headers", async (t) => {
  const { athena, base, proxy } = await setup(t, { ATHENA_JARVIS_TOKEN: " jarvis-token " });
  assert.equal(proxy.target, athena.url);
  const response = await fetch(`${base}/jarvis/mic?x=1`, {
    method: "POST",
    // The app's own origin, as a browser sends on a POST.
    headers: {
      "content-type": "application/json",
      origin: new URL(base).origin,
      referer: `${base}/`,
      cookie: "a=b",
      authorization: "Bearer phone",
    },
    body: JSON.stringify({ state: "toggle" }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-athena-jarvis-host"), "127.0.0.1");
  assert.deepEqual(await response.json(), { jarvis: { running: true } });
  const [request] = athena.seen;
  assert.equal(request.url, "/jarvis/mic?x=1");
  assert.equal(request.body, JSON.stringify({ state: "toggle" }));
  assert.equal(request.headers.authorization, "Bearer jarvis-token");
  assert.equal(request.headers.origin, undefined);
  assert.equal(request.headers.referer, undefined);
  assert.equal(request.headers.cookie, undefined);
  assert.equal(request.headers.host, new URL(athena.url).host);
});

test("Jarvis's own error answers pass through unchanged", async (t) => {
  const { base, athena } = await setup(t);
  const response = await fetch(`${base}/jarvis/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"text":"hi"}' });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "Jarvis is not running", jarvis: { running: false } });
  // No token configured, so none is sent.
  assert.equal(athena.seen[0].headers.authorization, undefined);
});

test("the event stream arrives unbuffered", async (t) => {
  const { base } = await setup(t);
  const controller = new AbortController();
  const response = await fetch(`${base}/jarvis/events`, { signal: controller.signal });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const { value } = await response.body.getReader().read();
  assert.match(new TextDecoder().decode(value), /event: jarvis\ndata: \{"running":true\}/);
  controller.abort();
});

test("a stream that goes quiet is closed so the phone reconnects", async (t) => {
  const { base } = await setup(t, {}, { streamIdleMs: 100 });
  const reader = (await fetch(`${base}/jarvis/events`)).body.getReader();
  await reader.read();
  const ended = await Promise.race([
    (async () => {
      for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return "ended";
    })(),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ]);
  assert.equal(ended, "ended");
});

test("a stream the target drops ends on the phone too", async (t) => {
  const { base } = await setup(t);
  const reader = (await fetch(`${base}/jarvis/events?drop=1`)).body.getReader();
  await reader.read();
  const ended = await Promise.race([
    reader.read().then(() => "ended", () => "ended"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ]);
  assert.equal(ended, "ended");
});

test("a target with a base path keeps it", async (t) => {
  const athena = await fakeAthena();
  const proxy = createJarvisProxy({ env: { ATHENA_JARVIS_TARGET: `${athena.url}/base/` } });
  const { server, base } = await mount(proxy);
  t.after(() => {
    server.close();
    athena.server.close();
  });
  const reader = (await fetch(`${base}/jarvis/events`)).body.getReader();
  await reader.read();
  assert.equal(athena.seen[0].url, "/base/jarvis/events");
});

test("only the Jarvis routes, with GET or POST, from this site", async (t) => {
  const { athena, base } = await setup(t);
  assert.equal((await fetch(`${base}/terminals`)).status, 404);
  assert.equal((await fetch(`${base}/jarvis/../terminals/spawn`, { method: "POST", body: "{}" })).status, 404);
  assert.equal((await fetch(`${base}/jarvisx`)).status, 404);
  assert.equal((await fetch(`${base}/jarvis`, { method: "DELETE" })).status, 405);
  const crossSite = await fetch(`${base}/jarvis/ask`, { method: "POST", headers: { origin: "https://evil.example" }, body: '{"text":"hi"}' });
  assert.equal(crossSite.status, 403);
  assert.equal(athena.seen.length, 0);
});

test("a path can't redirect the request, or its token, to another host", async (t) => {
  const { athena, base } = await setup(t, { ATHENA_JARVIS_TOKEN: "jarvis-token" });
  const elsewhere = await fakeAthena();
  t.after(() => elsewhere.server.close());
  const { port } = new URL(base);
  // A raw request line, since fetch would normalize the path.
  await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: `/athena-jarvis//127.0.0.1:${new URL(elsewhere.url).port}/jarvis` }, (response) => {
      response.resume();
      response.on("end", resolve);
    }).on("error", reject);
  });
  assert.equal(elsewhere.seen.length, 0);
  assert.equal(athena.seen.at(-1).url, "/jarvis");
});

test("an unreachable target is a 502 with a plain reason", async (t) => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const proxy = createJarvisProxy({ env: { ATHENA_JARVIS_TARGET: `http://127.0.0.1:${port}` } });
  const { server, base } = await mount(proxy);
  t.after(() => server.close());
  const response = await fetch(`${base}/jarvis`);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, new RegExp(`Athena at 127\\.0\\.0\\.1:${port} isn't answering`));
});
