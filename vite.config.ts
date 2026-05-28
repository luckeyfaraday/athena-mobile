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
      },
    },
  },
});

function discoveryUrl(fileName: string): string | null {
  try {
    const filePath = path.join(os.homedir(), ".context-workspace", fileName);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as { baseUrl?: unknown };
    return typeof data.baseUrl === "string" && data.baseUrl.trim() ? data.baseUrl.trim() : null;
  } catch {
    return null;
  }
}
