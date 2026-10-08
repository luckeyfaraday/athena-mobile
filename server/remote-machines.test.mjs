import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  athenaUserDataDir,
  classifyProbe,
  createRemoteMachines,
  discoverMachines,
  parseTailscaleStatus,
  remotePort,
} from "./remote-machines.mjs";

const RAW_STATUS = {
  BackendState: "Running",
  Self: { ID: "self-id", HostName: "laptop", DNSName: "laptop.tail.ts.net.", OS: "linux", Online: true, TailscaleIPs: ["100.64.0.1"], UserID: 1 },
  Peer: {
    a: { ID: "win-id", HostName: "WIN-PC", DNSName: "win-pc.tail.ts.net.", OS: "windows", Online: true, TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"], UserID: 1 },
    b: { ID: "phone-id", HostName: "phone", DNSName: "phone.tail.ts.net.", OS: "iOS", Online: true, TailscaleIPs: ["100.64.0.3"], UserID: 1 },
    c: { ID: "old-id", HostName: "old", DNSName: "old.tail.ts.net.", OS: "linux", Online: false, TailscaleIPs: ["100.64.0.4"], UserID: 1 },
    d: { ID: "server-id", HostName: "server", DNSName: "server.tail.ts.net.", OS: "linux", Online: true, TailscaleIPs: ["100.64.0.5"], UserID: 2, Tags: ["tag:server"] },
  },
  User: { 1: { LoginName: "ada@example.com" }, 2: { LoginName: "tagged-devices" } },
};

test("parseTailscaleStatus keeps the fields discovery needs", () => {
  const status = parseTailscaleStatus(RAW_STATUS);
  assert.equal(status.backendState, "Running");
  assert.equal(status.self.loginName, "ada@example.com");
  const windows = status.peers.find((peer) => peer.id === "win-id");
  assert.deepEqual(windows, {
    id: "win-id",
    hostName: "WIN-PC",
    dnsName: "win-pc.tail.ts.net",
    os: "windows",
    online: true,
    addresses: ["100.64.0.2", "fd7a:115c:a1e0::2"],
    userId: 1,
    loginName: "ada@example.com",
    tags: [],
  });
  assert.equal(parseTailscaleStatus(null), null);
});

test("discoverMachines probes online desktops only and orders usable ones first", async () => {
  const probed = [];
  const state = await discoverMachines({
    status: parseTailscaleStatus(RAW_STATUS),
    port: 47821,
    tokenFor: (id) => (id === "server-id" ? "tok" : null),
    probe: async (url, token) => {
      probed.push([url, token]);
      if (url.includes("100.64.0.2")) return { kind: "ok", body: { version: "0.4.1", platform: "win32", homedir: "C:\\Users\\ada" } };
      return { kind: "http", status: 401, error: "Missing or invalid remote access token." };
    },
    now: () => Date.parse("2026-10-07T12:00:00Z"),
  });
  // The phone is not a desktop; the offline machine is listed without a probe.
  assert.deepEqual(probed.sort(), [["http://100.64.0.2:47821", null], ["http://100.64.0.5:47821", "tok"]]);
  assert.deepEqual(state.machines.map((machine) => [machine.name, machine.status]), [
    ["win-pc", "ready"],
    ["server", "needs-token"],
    ["old", "offline"],
  ]);
  const [windows, server] = state.machines;
  assert.equal(windows.ownDevice, true);
  assert.equal(windows.platform, "win32");
  assert.equal(server.ownDevice, false);
  assert.match(server.detail, /Not on your Tailscale account/);
  assert.equal(state.account, "ada@example.com");
});

test("discoverMachines reports Tailscale being unavailable", async () => {
  const state = await discoverMachines({ status: null, port: 47821, probe: async () => assert.fail("no probe"), tokenFor: () => null });
  assert.equal(state.tailscale, "unavailable");
  assert.deepEqual(state.machines, []);
});

test("classifyProbe matches desktop Athena's statuses", () => {
  assert.equal(classifyProbe({ kind: "unreachable", code: "ECONNREFUSED" }).status, "no-athena");
  assert.equal(classifyProbe({ kind: "http", status: 429, error: null }).status, "refused");
  assert.equal(classifyProbe({ kind: "http", status: 500, error: null }).status, "unknown");
});

test("athenaUserDataDir follows Electron's userData location per platform", () => {
  assert.equal(athenaUserDataDir({}, "linux", "/home/ada"), "/home/ada/.config/context-workspace-client");
  assert.equal(athenaUserDataDir({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/ada"), "/cfg/context-workspace-client");
  assert.equal(athenaUserDataDir({}, "darwin", "/Users/ada"), "/Users/ada/Library/Application Support/context-workspace-client");
  assert.equal(athenaUserDataDir({ ATHENA_USER_DATA: "/x" }, "linux", "/home/ada"), "/x");
});

test("remotePort reads desktop Athena's setting and ignores nonsense", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-remote-"));
  assert.equal(remotePort(dir, {}), 47821);
  fs.writeFileSync(path.join(dir, "remote-access.json"), JSON.stringify({ port: 50000 }));
  assert.equal(remotePort(dir, {}), 50000);
  assert.equal(remotePort(dir, { ATHENA_REMOTE_PORT: "51000" }), 51000);
  fs.writeFileSync(path.join(dir, "remote-access.json"), JSON.stringify({ port: 80 }));
  assert.equal(remotePort(dir, {}), 47821);
});

// A stand-in for another machine's Athena: records what reached it and can
// hold an event stream open.
async function fakeRemote() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.startsWith("/terminals/t1/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: output\ndata: first\n\n");
        return;
      }
      if (req.url.startsWith("/terminals/drop/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: output\ndata: first\n\n");
        // The machine goes away mid-stream.
        setTimeout(() => req.socket.destroy(), 50);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, seen, port: server.address().port };
}

async function gateway(remotePortNumber, { tokens = {}, preferences = null, online = true } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "athena-remote-"));
  fs.writeFileSync(path.join(userDataDir, "remote-access.json"), JSON.stringify({ port: remotePortNumber }));
  fs.writeFileSync(path.join(userDataDir, "remote-tokens.json"), JSON.stringify(tokens));
  if (preferences) fs.writeFileSync(path.join(userDataDir, "athena-preferences.json"), JSON.stringify(preferences));
  const status = {
    BackendState: "Running",
    Self: { ID: "self-id", HostName: "laptop", DNSName: "laptop.tail.ts.net.", OS: "linux", Online: true, TailscaleIPs: ["100.64.0.1"], UserID: 1 },
    Peer: { a: { ID: "win-id", HostName: "WIN", DNSName: "win.tail.ts.net.", OS: "windows", Online: online, TailscaleIPs: ["127.0.0.1"], UserID: 1 } },
    User: { 1: { LoginName: "ada@example.com" } },
  };
  const remote = createRemoteMachines({ readStatus: async () => status, userDataDir });
  const server = http.createServer((req, res) => {
    req.url = req.url.slice("/athena-remote".length);
    void remote.middleware(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}/athena-remote` };
}

test("the gateway forwards to the chosen machine with its token and without browser headers", async (t) => {
  const remote = await fakeRemote();
  const { server, base } = await gateway(remote.port, { tokens: { "win-id": "secret-token" } });
  t.after(() => {
    server.close();
    remote.server.closeAllConnections();
    remote.server.close();
  });

  const response = await fetch(`${base}/m/win-id/terminals/spawn?x=1`, {
    method: "POST",
    // The app's own origin, as a browser sends on a POST; the remote refuses any Origin.
    headers: { "content-type": "application/json", origin: new URL(base).origin, cookie: "a=b", authorization: "Bearer phone" },
    body: JSON.stringify({ kind: "codex" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const [request] = remote.seen;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/terminals/spawn?x=1");
  assert.equal(request.body, JSON.stringify({ kind: "codex" }));
  assert.equal(request.headers.authorization, "Bearer secret-token");
  assert.equal(request.headers.origin, undefined);
  assert.equal(request.headers.cookie, undefined);
  assert.equal(request.headers.host, `127.0.0.1:${remote.port}`);
});

test("the gateway streams events as they arrive", async (t) => {
  const remote = await fakeRemote();
  const { server, base } = await gateway(remote.port);
  t.after(() => {
    server.close();
    remote.server.closeAllConnections();
    remote.server.close();
  });
  const controller = new AbortController();
  const response = await fetch(`${base}/m/win-id/terminals/t1/stream`, { signal: controller.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /data: first/);
  // No token was saved for this machine, so none is sent.
  assert.equal(remote.seen[0].headers.authorization, undefined);
  controller.abort();
});

test("the gateway only targets machines Tailscale knows, and only GET or POST", async (t) => {
  const remote = await fakeRemote();
  const { server, base } = await gateway(remote.port);
  t.after(() => {
    server.close();
    remote.server.close();
  });
  assert.equal((await fetch(`${base}/m/somewhere-else/terminals`)).status, 404);
  assert.equal((await fetch(`${base}/m/win-id/terminals`, { method: "DELETE" })).status, 405);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal(remote.seen.length, 0);
});

test("the gateway refuses an offline machine", async (t) => {
  const { server, base } = await gateway(1, { online: false });
  t.after(() => server.close());
  const response = await fetch(`${base}/m/win-id/terminals`);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /offline/);
});

test("/machines lists machines with the laptop's name and desktop theme", async (t) => {
  const remote = await fakeRemote();
  const { server, base } = await gateway(remote.port, { preferences: { "context-workspace:uiTheme": "fjord" } });
  t.after(() => {
    server.close();
    remote.server.close();
  });
  const state = await (await fetch(`${base}/machines`)).json();
  assert.deepEqual(state.self, { name: "laptop", theme: "fjord" });
  assert.equal(state.machines.length, 1);
  // The fake answers /machine with 200, so the machine is ready.
  assert.equal(state.machines[0].status, "ready");
  assert.equal(state.machines[0].name, "win");
});

test("a path can't redirect the request, or its token, to another host", async (t) => {
  const remote = await fakeRemote();
  const { server, base } = await gateway(remote.port, { tokens: { "win-id": "secret-token" } });
  const elsewhere = await fakeRemote();
  t.after(() => {
    server.close();
    remote.server.close();
    elsewhere.server.close();
  });
  await fetch(`${base}/m/win-id//127.0.0.1:${elsewhere.port}/terminals`);
  assert.equal(elsewhere.seen.length, 0);
  // It reached the chosen machine, as a path that machine will reject.
  assert.equal(remote.seen.at(-1).url, `//127.0.0.1:${elsewhere.port}/terminals`);
});

test("a stream the remote drops ends on the phone too, so it reconnects", async (t) => {
  const remote = await fakeRemote();
  const { server, base } = await gateway(remote.port);
  t.after(() => {
    server.close();
    remote.server.close();
  });
  const response = await fetch(`${base}/m/win-id/terminals/drop/stream`);
  const reader = response.body.getReader();
  await reader.read();
  const ended = await Promise.race([
    reader.read().then(() => "ended", () => "ended"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ]);
  assert.equal(ended, "ended");
});

test("requests from another site are refused", async (t) => {
  const remote = await fakeRemote();
  const { server, base } = await gateway(remote.port);
  t.after(() => {
    server.close();
    remote.server.close();
  });
  const response = await fetch(`${base}/m/win-id/terminals/kill`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
  assert.equal(response.status, 403);
  assert.equal(remote.seen.length, 0);
});
