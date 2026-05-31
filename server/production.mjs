import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPushNotifier } from "./push-notifier.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const host = resolveHost();
const port = Number(process.env.PORT || process.env.ATHENA_MOBILE_PORT || 4174);
const notifier = createPushNotifier();

if (!fs.existsSync(path.join(distDir, "index.html"))) {
  console.error("Missing dist/index.html. Run `npm run build` before `npm start`.");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (!req.url) return sendText(res, 400, "Bad request");
  if (req.url.startsWith("/athena-backend")) {
    return proxyRequest(req, res, "/athena-backend", targetFromDiscovery("backend.json", "ATHENA_BACKEND_TARGET", "http://127.0.0.1:8000"));
  }
  if (req.url.startsWith("/athena-control")) {
    return proxyRequest(req, res, "/athena-control", targetFromDiscovery("electron-control.json", "ATHENA_CONTROL_TARGET", "http://127.0.0.1:9000"));
  }
  if (req.url.startsWith("/athena-push")) {
    req.url = req.url.slice("/athena-push".length) || "/";
    return notifier.middleware(req, res);
  }
  return serveStatic(req, res);
});

server.listen(port, host, () => {
  notifier.start();
  console.log(`Athena Mobile listening at http://${host}:${port}`);
});

function shutdown() {
  notifier.stop();
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function proxyRequest(req, res, prefix, targetInfo) {
  const rewrittenPath = req.url.replace(new RegExp(`^${prefix}`), "") || "/";
  const target = new URL(rewrittenPath, targetInfo.baseUrl);
  const headers = { ...req.headers, host: target.host };
  delete headers.origin;
  delete headers.referer;
  if (targetInfo.token) headers.authorization = `Bearer ${targetInfo.token}`;

  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(
    target,
    { method: req.method, headers },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, stripHopByHopHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Athena proxy failed: ${error.message}` }));
  });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://athena-mobile.local");
  const pathname = decodeURIComponent(url.pathname);
  const requested = path.normalize(path.join(distDir, pathname));
  if (!requested.startsWith(distDir)) return sendText(res, 403, "Forbidden");

  const file = fs.existsSync(requested) && fs.statSync(requested).isFile()
    ? requested
    : path.join(distDir, "index.html");
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType(file));
  fs.createReadStream(file).pipe(res);
}

function targetFromDiscovery(fileName, envName, fallback) {
  const discovered = readDiscovery(fileName);
  return {
    baseUrl: process.env[envName] || discovered.baseUrl || fallback,
    token: discovered.token,
  };
}

function readDiscovery(fileName) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".context-workspace", fileName), "utf8"));
    return {
      baseUrl: typeof data?.baseUrl === "string" && data.baseUrl.trim() ? data.baseUrl.trim() : null,
      token: typeof data?.token === "string" && data.token.trim() ? data.token.trim() : null,
    };
  } catch {
    return { baseUrl: null, token: null };
  }
}

function stripHopByHopHeaders(headers) {
  const next = { ...headers };
  delete next.connection;
  delete next["keep-alive"];
  delete next["proxy-authenticate"];
  delete next["proxy-authorization"];
  delete next.te;
  delete next.trailer;
  delete next["transfer-encoding"];
  delete next.upgrade;
  return next;
}

function resolveHost() {
  const requested = process.env.ATHENA_HOST?.trim();
  if (!requested) return "127.0.0.1";
  if (requested.toLowerCase() === "tailscale") {
    const tailscaleIp = findTailscaleIp();
    if (!tailscaleIp) throw new Error("ATHENA_HOST=tailscale but no Tailscale IPv4 address was found.");
    return tailscaleIp;
  }
  return requested;
}

function findTailscaleIp() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && isCgnat(address.address)) return address.address;
    }
  }
  return null;
}

function isCgnat(ip) {
  const octets = ip.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [first, second] = octets;
  return first === 100 && second >= 64 && second <= 127;
}

function contentType(file) {
  const ext = path.extname(file);
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json; charset=utf-8",
  }[ext] || "application/octet-stream";
}

function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}
