// Jarvis, the user's licensed voice assistant, on whichever computer runs it.
//
// Athena serves Jarvis on its control API (GET /jarvis, GET /jarvis/events,
// GET /jarvis/audio/<turn>/<seq> for replies in Jarvis's voice, POST
// /jarvis/ask|mic|launch), so the phone usually finds it through the
// host's own Athena (/athena-control) or another machine's (/athena-remote).
// This mount is the explicit route: ATHENA_JARVIS_TARGET names one Athena
// control API, here or on the tailnet, and /athena-jarvis/jarvis… is forwarded
// there with ATHENA_JARVIS_TOKEN (optional) as its bearer token.
//
// Only loopback and Tailscale addresses are accepted, so a typo can't send the
// token, or what the user says to Jarvis, across the internet. Only the /jarvis
// routes are forwarded, so the mount can't drive the rest of that control API
// (terminals, spawn). Without a usable target every request gets 404
// {error: "not configured"}, which the phone reads as "look elsewhere".
// Answers name the target in X-Athena-Jarvis-Host, so the phone can say which
// machine it is before Jarvis there has told it anything.

import http from "node:http";
import net from "node:net";
import { pipeline } from "node:stream";

// Until the target answers. Asking Jarvis returns once the request is queued.
const RESPONSE_TIMEOUT_MS = 30_000;
// Athena's Jarvis stream sends a keep-alive every 15 s, so a stream this quiet
// is dead (the machine slept or its network dropped) and the phone should
// reconnect. Same watchdog as remote-machines.mjs.
const STREAM_IDLE_TIMEOUT_MS = 45_000;

/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(line: string) => void} [options.log] where a refused target is reported
 * @param {number} [options.streamIdleMs]
 * @param {number} [options.responseTimeoutMs]
 */
export function createJarvisProxy(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line) => console.warn(line));
  const timeouts = {
    idle: options.streamIdleMs ?? STREAM_IDLE_TIMEOUT_MS,
    response: options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS,
  };
  const token = env.ATHENA_JARVIS_TOKEN?.trim() || null;
  const raw = env.ATHENA_JARVIS_TARGET?.trim();
  let target = null;
  if (raw) {
    const parsed = parseJarvisTarget(raw);
    if (parsed.ok) target = parsed.url;
    else log(`ATHENA_JARVIS_TARGET refused: ${parsed.reason}. /athena-jarvis stays off.`);
  }

  function middleware(req, res) {
    if (!target) return sendJson(res, 404, { error: "not configured" });
    // Another site open in the phone's browser must not talk to Jarvis.
    if (!sameOrigin(req)) return sendJson(res, 403, { error: "Cross-site requests are refused." });
    let url;
    try {
      url = new URL(req.url || "/", "http://athena-mobile.local");
    } catch {
      return sendJson(res, 400, { error: "Bad request." });
    }
    if (url.pathname !== "/jarvis" && !url.pathname.startsWith("/jarvis/")) {
      return sendJson(res, 404, { error: `Only Jarvis is served here, not ${url.pathname}.` });
    }
    if (req.method !== "GET" && req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });
    // Set only the path, so a path like "//elsewhere/x" can't change the host the token goes to.
    const upstream = new URL(target);
    upstream.pathname = `${target.pathname.replace(/\/+$/, "")}${url.pathname}`;
    upstream.search = url.search;
    if (upstream.host !== target.host) return sendJson(res, 400, { error: "Bad Jarvis path." });
    forward(req, res, upstream, token, timeouts);
  }

  return { middleware, target: target ? target.href.replace(/\/$/, "") : null };
}

/**
 * ATHENA_JARVIS_TARGET must be a plain http:// URL on this machine or the
 * tailnet: loopback, Tailscale's 100.64.0.0/10 and fd7a:115c:a1e0::/48
 * addresses, or a MagicDNS *.ts.net name.
 */
export function parseJarvisTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "it isn't a URL (expected e.g. http://100.101.102.103:47821)" };
  }
  if (url.protocol !== "http:") return { ok: false, reason: `use http:// (got ${url.protocol}//); Athena's control API is plain HTTP over Tailscale` };
  if (url.username || url.password) return { ok: false, reason: "put the token in ATHENA_JARVIS_TOKEN, not in the URL" };
  if (url.search || url.hash) return { ok: false, reason: "drop the query or fragment from the URL" };
  if (!isTailnetOrLoopbackHost(url.hostname)) {
    return { ok: false, reason: `${url.hostname} is not loopback or a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48, *.ts.net)` };
  }
  return { ok: true, url };
}

/** `hostname` as URL parses it: lower-case, IPv6 in brackets. */
export function isTailnetOrLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  if (host === "localhost") return true;
  if (net.isIPv4(host)) {
    const [first, second] = host.split(".").map(Number);
    return first === 127 || (first === 100 && second >= 64 && second <= 127);
  }
  if (net.isIPv6(host)) {
    const groups = expandIPv6(host);
    if (!groups) return false;
    if (groups.every((group, index) => group === (index === 7 ? 1 : 0))) return true;
    return groups[0] === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0;
  }
  // A MagicDNS name: at least the machine and tailnet labels before ts.net.
  return /^([a-z0-9-]+\.)+ts\.net$/.test(host) && host.split(".").length >= 4;
}

// Eight 16-bit groups, or null for a form not worth accepting (an embedded IPv4).
function expandIPv6(address) {
  if (address.includes(".")) return null;
  const [head, tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = address.includes("::") ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

// Forward only what the control API needs: no cookies, Origin, or Referer (a
// remote Athena refuses browser requests). The event stream is piped as it
// arrives; closing the phone's request tears down the upstream one.
function forward(req, res, target, token, timeouts) {
  res.setHeader("X-Athena-Jarvis-Host", target.hostname);
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
    if (String(response.headers["content-type"] ?? "").includes("text/event-stream")) {
      forwarded["x-accel-buffering"] = "no";
      let idle;
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => response.destroy(new Error("stream went quiet")), timeouts.idle);
      };
      arm();
      response.on("data", arm);
      response.on("close", () => clearTimeout(idle));
    }
    res.writeHead(response.statusCode ?? 502, forwarded);
    // A target that drops mid-stream closes the phone's connection too, so its
    // EventSource notices and reconnects instead of sitting "live" forever.
    pipeline(response, res, () => {});
  });
  upstream.setTimeout(timeouts.response, () => {
    // Only the wait for an answer is bounded here; streams have their own watchdog.
    if (!res.headersSent) upstream.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
  });
  upstream.on("error", (error) => {
    if (res.headersSent) return res.destroy();
    const code = error.code ?? "";
    sendJson(res, 502, {
      error: /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ECONNRESET/.test(code)
        ? `Athena at ${target.host} isn't answering. Check that it's running there.`
        : `Couldn't reach Athena at ${target.host}: ${error.message}`,
    });
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

/** No Origin (same-origin GET), or an Origin naming the host the request came in on. Same rule as remote-machines.mjs. */
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
