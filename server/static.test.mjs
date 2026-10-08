import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serveStatic } from "./static.mjs";

test("static server keeps missing build assets out of the SPA fallback", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "athena-static-"));
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "index.html"), "<h1>Athena</h1>");
  await fs.writeFile(path.join(dir, "sw.js"), "// worker");
  await fs.writeFile(path.join(dir, "assets/app-123.js"), "// app");
  const server = http.createServer((req, res) => serveStatic(req, res, dir));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const url of ["/assets/old.js", "/assets/old.css", "/assets/missing", "/missing.png"]) {
    const res = await fetch(base + url, { headers: { accept: "text/html" } });
    assert.equal(res.status, 404, url);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), "Not found");
  }
  for (const url of ["/", "/?terminal=t1", "/conversation"]) {
    const res = await fetch(base + url, { headers: { accept: "text/html" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.equal(await res.text(), "<h1>Athena</h1>");
  }
  const worker = await fetch(base + "/sw.js");
  assert.equal(worker.headers.get("cache-control"), "no-cache");
  const asset = await fetch(base + "/assets/app-123.js");
  assert.match(asset.headers.get("content-type"), /javascript/);
  assert.match(asset.headers.get("cache-control"), /immutable/);
  assert.equal((await fetch(base + "/%ZZ")).status, 400);
  assert.equal((await fetch(base + "/..%2Foutside.js")).status, 403);
});
