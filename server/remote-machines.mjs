// Other machines' Athena, reached through this laptop.
//
// Athena's remote access (context-workspace client/electron/remote-access.ts)
// serves the same control API as the local control server on each machine's
// Tailscale addresses, port 47821 by default. The phone can't call those
// listeners itself: they refuse browser requests, and pairing tokens live on
// the laptop. So the laptop does what desktop Athena's machine switcher does:
//
//   GET  /machines          the other desktops on the tailnet, each asked who it is
//   ANY  /m/<machineId>/... that machine's control API (terminals, stream, spawn…)
//
// Only machines Tailscale reports as this account's peers can be targeted, so
// the proxy can't be pointed at an arbitrary host. Pairing tokens are read from
// desktop Athena's own store and never leave the laptop.

import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream";

export const DEFAULT_REMOTE_PORT = 47821;
const STATUS_TTL_MS = 15_000;
const PROBE_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_500;
const CLI_TIMEOUT_MS = 3_000;
// Until the remote answers. A spawn or a cold history scan there can take a while.
const PROXY_RESPONSE_TIMEOUT_MS = 30_000;
// Athena's event streams send a keep-alive every 15 s, so a stream this quiet
// is dead (the machine slept or its network dropped) and the phone should reconnect.
const STREAM_IDLE_TIMEOUT_MS = 45_000;
// Athena runs on desktops; phones and appliances on the tailnet are left out.
const DESKTOP_OS = new Set(["linux", "windows", "macos", "darwin"]);
const STATUS_ORDER = { ready: 0, "needs-token": 1, refused: 2, unknown: 3, "no-athena": 4, offline: 5 };
const THEME_PREFERENCE_KEY = "context-workspace:uiTheme";

/**
 * @param {object} [options]
 * @param {() => Promise<unknown>} [options.readStatus] raw `tailscale status --json`
 * @param {(url: string, token: string | null) => Promise<ProbeResult>} [options.probe]
 * @param {string} [options.userDataDir] desktop Athena's Electron userData folder
 * @param {() => number} [options.now]
 */
export function createRemoteMachines(options = {}) {
  const readStatus = options.readStatus ?? runTailscaleStatus;
  const probe = options.probe ?? probeMachine;
  const userData = options.userDataDir ?? athenaUserDataDir();
  const now = options.now ?? Date.now;

  let status = null;
  // The last status that read successfully, so one failed CLI run can't make
  // every machine look gone.
  let lastGood = null;
  let statusAt = 0;
  let statusInFlight = null;
  let listing = null;
  let listingAt = 0;
  let listingInFlight = null;

  function tailscaleStatus(maxAgeMs = STATUS_TTL_MS) {
    if (statusAt && now() - statusAt < maxAgeMs) return Promise.resolve(status);
    statusInFlight ??= readStatus()
      .then((raw) => parseTailscaleStatus(raw))
      .catch(() => null)
      .then((next) => {
        status = next;
        if (next) lastGood = next;
        statusAt = now();
        return next;
      })
      .finally(() => {
        statusInFlight = null;
      });
    return statusInFlight;
  }

  async function machines(fresh) {
    if (!fresh && listing && now() - listingAt < PROBE_TTL_MS) return listing;
    listingInFlight ??= (async () => {
      const current = await tailscaleStatus(fresh ? 0 : STATUS_TTL_MS);
      const next = await discoverMachines({
        status: current,
        port: remotePort(userData),
        probe,
        tokenFor: (id) => readTokens(userData)[id] ?? null,
        now,
      });
      listing = next;
      listingAt = now();
      return next;
    })().finally(() => {
      listingInFlight = null;
    });
    return listingInFlight;
  }

  async function middleware(req, res) {
    // Another site open in the phone's browser must not drive these machines.
    if (!sameOrigin(req)) return sendJson(res, 403, { error: "Cross-site requests are refused." });
    let url;
    try {
      url = new URL(req.url || "/", "http://athena-mobile.local");
    } catch {
      return sendJson(res, 400, { error: "Bad request." });
    }
    try {
      if (url.pathname === "/machines" && req.method === "GET") {
        const state = await machines(url.searchParams.get("fresh") === "1");
        return sendJson(res, 200, { ...state, self: selfInfo(lastGood, userData) });
      }
      const match = /^\/m\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (match) {
        if (req.method !== "GET" && req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });
        const machineId = decodeURIComponent(match[1]);
        const peer = await targetPeer(machineId);
        if (!peer) return sendJson(res, 404, { error: "That machine isn't on your tailnet any more." });
        if (!peer.online) return sendJson(res, 503, { error: `${machineName(peer)} is offline.` });
        const address = peerAddress(peer);
        if (!address) return sendJson(res, 503, { error: `${machineName(peer)} has no Tailscale address.` });
        // Set only the path, so a path like "//elsewhere/x" can't change the host the token goes to.
        const base = new URL(remoteUrl(address, remotePort(userData)));
        const target = new URL(base);
        target.pathname = match[2];
        target.search = url.search;
        if (target.host !== base.host) return sendJson(res, 400, { error: "Bad remote path." });
        return proxy(req, res, target, readTokens(userData)[machineId] ?? null, machineName(peer));
      }
      return sendJson(res, 404, { error: `Unknown remote endpoint: ${req.method} ${url.pathname}` });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    }
  }

  // A known peer by id: from the last good status, refreshed in the background
  // when old, so a stream or keystroke never waits on the Tailscale CLI. Only a
  // machine missing from it waits for a fresh read.
  async function targetPeer(machineId) {
    const find = (current) => current?.peers.find((peer) => peer.id === machineId && isDesktopNode(peer)) ?? null;
    if (lastGood && now() - statusAt >= STATUS_TTL_MS) void tailscaleStatus();
    return find(lastGood) ?? find(await tailscaleStatus(0));
  }

  return { middleware, machines };
}

/** @typedef {{ kind: "ok", body: Record<string, unknown> } | { kind: "http", status: number, error: string | null } | { kind: "unreachable", code: string }} ProbeResult */

export function parseTailscaleStatus(value) {
  if (!value || typeof value !== "object") return null;
  const users = value.User && typeof value.User === "object" ? value.User : {};
  const self = value.Self && typeof value.Self === "object" ? parseNode(value.Self, users) : null;
  const peers = value.Peer && typeof value.Peer === "object"
    ? Object.values(value.Peer).filter((peer) => peer && typeof peer === "object").map((peer) => parseNode(peer, users))
    : [];
  return { backendState: typeof value.BackendState === "string" ? value.BackendState : null, self, peers };
}

function parseNode(record, users) {
  const userId = typeof record.UserID === "number" ? record.UserID : null;
  const user = userId != null && users[String(userId)] && typeof users[String(userId)] === "object" ? users[String(userId)] : null;
  const text = (field) => (typeof field === "string" && field.trim() ? field.trim() : null);
  return {
    id: text(record.ID),
    hostName: text(record.HostName),
    dnsName: text(record.DNSName)?.replace(/\.$/, "") ?? null,
    os: text(record.OS),
    online: record.Online === true,
    addresses: Array.isArray(record.TailscaleIPs) ? record.TailscaleIPs.filter((ip) => typeof ip === "string") : [],
    userId,
    loginName: text(user?.LoginName),
    tags: Array.isArray(record.Tags) ? record.Tags.filter((tag) => typeof tag === "string") : [],
  };
}

export function isDesktopNode(node) {
  return Boolean(node.os && DESKTOP_OS.has(node.os.toLowerCase()));
}

export function machineName(node) {
  return node.dnsName?.split(".")[0] || node.hostName || node.addresses[0] || "unknown";
}

function peerAddress(node) {
  return node.addresses.find((candidate) => net.isIPv4(candidate)) ?? node.addresses[0] ?? null;
}

export function remoteUrl(address, port) {
  return net.isIPv6(address) ? `http://[${address}]:${port}` : `http://${address}:${port}`;
}

/** Same classification as desktop Athena's remote-machines.ts, so both apps describe a machine alike. */
export function classifyProbe(result) {
  const none = { version: null, platform: null, homedir: null };
  if (result.kind === "ok") {
    const text = (key) => (typeof result.body[key] === "string" ? result.body[key] : null);
    return { status: "ready", detail: null, version: text("version"), platform: text("platform"), homedir: text("homedir") };
  }
  if (result.kind === "unreachable") {
    return {
      ...none,
      status: "no-athena",
      detail: result.code === "ETIMEDOUT"
        ? "No answer. Athena may be closed, remote access may be off, or a firewall is blocking it."
        : "Athena is not running there, or its remote access is off.",
    };
  }
  if (result.status === 401) return { ...none, status: "needs-token", detail: result.error ?? "Needs this machine's access token." };
  if (result.status === 403 || result.status === 429) {
    return { ...none, status: "refused", detail: result.error ?? `Refused (HTTP ${result.status}).` };
  }
  return { ...none, status: "unknown", detail: result.error ?? `Unexpected answer (HTTP ${result.status}).` };
}

/** The other desktops on the tailnet, each probed on `port` (offline ones are not probed). */
export async function discoverMachines({ status, port, probe, tokenFor, now = Date.now }) {
  const refreshedAt = new Date(now()).toISOString();
  if (!status) return { tailscale: "unavailable", account: null, port, machines: [], refreshedAt };
  const self = status.self;
  const peers = status.peers.filter((peer) => peer.id && peer.id !== self?.id && isDesktopNode(peer));
  const machines = await Promise.all(peers.map(async (peer) => {
    const address = peerAddress(peer);
    const ownDevice = Boolean(
      self && self.userId != null && peer.userId === self.userId && peer.tags.length === 0 && self.tags.length === 0,
    );
    const base = { id: peer.id, name: machineName(peer), os: peer.os, online: peer.online, ownDevice };
    if (!peer.online || !address) {
      return { ...base, status: "offline", detail: null, version: null, platform: null, homedir: null };
    }
    const classified = classifyProbe(await probe(remoteUrl(address, port), tokenFor(peer.id)));
    if (classified.status === "needs-token") {
      classified.detail = ownDevice
        ? "Its “Trust my own devices” setting is off. Add its access token in Athena on this laptop (Settings → System → Your machines)."
        : "Not on your Tailscale account. Add its access token in Athena on this laptop (Settings → System → Your machines).";
    }
    return { ...base, ...classified };
  }));
  machines.sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || left.name.localeCompare(right.name));
  return {
    tailscale: status.backendState && status.backendState !== "Running" ? "stopped" : "running",
    account: self?.loginName ?? null,
    port,
    machines,
    refreshedAt,
  };
}

/** GET /machine on a remote Athena, with its token when one is known. */
export function probeMachine(url, token) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = http.get(
      new URL("/machine", url),
      { agent: false, headers: token ? { authorization: `Bearer ${token}` } : {} },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (text.length < 64_000) text += chunk;
        });
        response.on("end", () => {
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
          const record = body && typeof body === "object" ? body : {};
          if (response.statusCode === 200) finish({ kind: "ok", body: record });
          else finish({ kind: "http", status: response.statusCode ?? 0, error: typeof record.error === "string" ? record.error : null });
        });
        response.on("error", () => finish({ kind: "unreachable", code: "ECONNRESET" }));
      },
    );
    request.setTimeout(PROBE_TIMEOUT_MS, () => {
      request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    });
    request.on("error", (error) => finish({ kind: "unreachable", code: error.code ?? "ERROR" }));
  });
}

// Remote control refuses browser requests (any Origin) and checks Host, so
// forward only what the control API needs. The SSE stream is piped as it
// arrives; closing the phone's request tears down the upstream one.
function proxy(req, res, target, token, name) {
  const headers = { host: target.host, accept: req.headers.accept ?? "*/*" };
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
  if (req.headers["last-event-id"]) headers["last-event-id"] = req.headers["last-event-id"];
  if (token) headers.authorization = `Bearer ${token}`;

  const upstream = http.request(target, { method: req.method, headers, agent: false }, (response) => {
    const forwarded = { "cache-control": "no-store" };
    for (const key of ["content-type", "content-length", "cache-control"]) {
      if (response.headers[key]) forwarded[key] = response.headers[key];
    }
    const stream = String(response.headers["content-type"] ?? "").includes("text/event-stream");
    if (stream) {
      forwarded["x-accel-buffering"] = "no";
      let idle;
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => response.destroy(new Error("stream went quiet")), STREAM_IDLE_TIMEOUT_MS);
      };
      arm();
      response.on("data", arm);
      response.on("close", () => clearTimeout(idle));
    }
    res.writeHead(response.statusCode ?? 502, forwarded);
    // A remote that drops mid-response closes the phone's connection too, so
    // its EventSource notices and reconnects instead of sitting "live" forever.
    pipeline(response, res, () => {});
  });
  upstream.setTimeout(PROXY_RESPONSE_TIMEOUT_MS, () => {
    // Only the wait for an answer is bounded here; streams have their own watchdog.
    if (!res.headersSent) upstream.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
  });
  upstream.on("error", (error) => {
    if (res.headersSent) return res.destroy();
    const code = error.code ?? "";
    sendJson(res, 502, {
      error: /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ECONNRESET/.test(code)
        ? `${name} stopped answering. Check that Athena is still running there with remote access on.`
        : `Couldn't reach ${name}: ${error.message}`,
    });
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

// ---- desktop Athena's settings on this laptop --------------------------------

/** Electron's userData folder for the desktop app (package name context-workspace-client). */
export function athenaUserDataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.ATHENA_USER_DATA) return env.ATHENA_USER_DATA;
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "context-workspace-client");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "context-workspace-client");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "context-workspace-client");
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Discovery assumes every machine uses this laptop's remote port, as desktop Athena does. */
export function remotePort(userData, env = process.env) {
  const fromEnv = Number(env.ATHENA_REMOTE_PORT);
  if (Number.isInteger(fromEnv) && fromEnv >= 1024 && fromEnv <= 65535) return fromEnv;
  const port = readJson(path.join(userData, "remote-access.json"))?.port;
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_REMOTE_PORT;
}

/** Access tokens desktop Athena saved for machines that need one, keyed by Tailscale node id. */
export function readTokens(userData) {
  const tokens = readJson(path.join(userData, "remote-tokens.json")) ?? {};
  return Object.fromEntries(Object.entries(tokens).filter(([, token]) => typeof token === "string" && token.trim()).map(([id, token]) => [id, token.trim()]));
}

/** This laptop's name and desktop Athena's theme, so the phone can match it. */
function selfInfo(status, userData) {
  const theme = readJson(path.join(userData, "athena-preferences.json"))?.[THEME_PREFERENCE_KEY];
  return {
    name: (status?.self && machineName(status.self)) || os.hostname(),
    theme: typeof theme === "string" ? theme : null,
  };
}

function runTailscaleStatus() {
  const commands = process.platform === "darwin"
    ? ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
    : ["tailscale"];
  return commands.reduce(
    (previous, command) => previous.catch(() => new Promise((resolve, reject) => {
      execFile(command, ["status", "--json"], { timeout: CLI_TIMEOUT_MS, maxBuffer: 8_000_000 }, (error, stdout) => {
        if (error && !stdout) return reject(error);
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      });
    })),
    Promise.reject(new Error("tailscale not found")),
  );
}

/** No Origin (same-origin GET), or an Origin naming the host the request came in on. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
