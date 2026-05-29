import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/athena-backend": {
        target: process.env.ATHENA_BACKEND_TARGET || discoveryUrl("backend.json") || "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/athena-backend/, ""),
      },
      "/athena-control": {
        target: process.env.ATHENA_CONTROL_TARGET || discoveryUrl("electron-control.json") || "http://127.0.0.1:9000",
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/athena-control/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            // The Electron control server only trusts loopback callers that hold
            // the per-launch token from the 0600 electron-control.json discovery
            // file. This dev server runs on the laptop as the same OS user, so it
            // can read that token and present it on the phone's behalf. The token
            // is read per-request so it survives control-server restarts.
            const token = discoveryToken("electron-control.json");
            if (token) proxyReq.setHeader("authorization", `Bearer ${token}`);
            // changeOrigin already rewrites Host to the loopback target; drop the
            // phone's Origin/Referer so the loopback-origin check passes too.
            proxyReq.removeHeader("origin");
            proxyReq.removeHeader("referer");
          });
        },
      },
    },
  },
});

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
