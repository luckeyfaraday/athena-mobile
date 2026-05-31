import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { athenaPushPlugin } from "./server/push-plugin.mjs";

export default defineConfig({
  plugins: [react(), athenaControlProxyPlugin(), athenaPushPlugin()],
  server: {
    host: resolveHost(),
    port: 5174,
    // `tailscale serve` terminates HTTPS and proxies to this loopback server,
    // forwarding the tailnet hostname as the Host header. Vite's dev-server host
    // check must accept it; any *.ts.net MagicDNS name is allowed.
    allowedHosts: [".ts.net"],
    proxy: {
      "/athena-backend": {
        target: process.env.ATHENA_BACKEND_TARGET || discoveryUrl("backend.json") || "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/athena-backend/, ""),
      },
    },
  },
});

function athenaControlProxyPlugin() {
  return {
    name: "athena-control-dynamic-proxy",
    configureServer(server) {
      server.middlewares.use("/athena-control", (req, res) => {
        proxyControlRequest(req, res);
      });
    },
  };
}

function proxyControlRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const baseUrl = process.env.ATHENA_CONTROL_TARGET || discoveryUrl("electron-control.json") || "http://127.0.0.1:9000";
  const target = new URL(req.url || "/", baseUrl);
  const token = discoveryToken("electron-control.json");
  const headers = { ...req.headers, host: target.host };
  delete headers.origin;
  delete headers.referer;
  if (token) headers.authorization = `Bearer ${token}`;

  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(
    target,
    {
      method: req.method,
      headers,
    },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, stripHopByHopHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Electron control proxy failed: ${error.message}` }));
  });
  req.pipe(upstream);
}

function stripHopByHopHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
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

function discoveryFilePath(fileName: string): string {
  return path.join(os.homedir(), ".context-workspace", fileName);
}

function readDiscovery(fileName: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(fs.readFileSync(discoveryFilePath(fileName), "utf8")) as unknown;
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function discoveryUrl(fileName: string): string | null {
  const baseUrl = readDiscovery(fileName)?.baseUrl;
  return typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : null;
}

function discoveryToken(fileName: string): string | null {
  const token = readDiscovery(fileName)?.token;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

// Resolve the dev-server bind address from ATHENA_HOST:
//   unset       -> 127.0.0.1 (loopback only)
//   "tailscale" -> this machine's Tailscale IP, so a phone on the tailnet can
//                  reach the app without exposing it on every interface
//   <value>     -> used verbatim (an explicit IP, or "0.0.0.0" to opt into
//                  binding all interfaces deliberately)
// The proxy above forwards loopback-trusted requests to Athena's control server,
// so the default deliberately avoids 0.0.0.0: binding all interfaces would expose
// that control surface to any untrusted LAN/Wi-Fi the laptop is also joined to.
function resolveHost(): string {
  const requested = process.env.ATHENA_HOST?.trim();
  if (!requested) return "127.0.0.1";
  if (requested.toLowerCase() === "tailscale") {
    const tailscaleIp = findTailscaleIp();
    if (!tailscaleIp) {
      throw new Error(
        "ATHENA_HOST=tailscale but no Tailscale IPv4 address (100.64.0.0/10) was found. " +
          "Start Tailscale, or set ATHENA_HOST to an explicit bind address.",
      );
    }
    return tailscaleIp;
  }
  return requested;
}

function findTailscaleIp(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && isCgnat(address.address)) {
        return address.address;
      }
    }
  }
  return null;
}

// Tailscale assigns each node an address in the 100.64.0.0/10 CGNAT range.
function isCgnat(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [first, second] = octets;
  return first === 100 && second >= 64 && second <= 127;
}
