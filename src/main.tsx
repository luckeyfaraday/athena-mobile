import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register the service worker in any secure context (HTTPS, or localhost). It
// powers two things: app-shell caching for instant repaint after the OS evicts
// the backgrounded PWA, and Web Push for agent-attention alerts. A non-secure
// origin (plain-HTTP over Tailscale) exposes no service worker at all, so this
// no-ops there — reach the app over `tailscale serve` HTTPS to enable both.
//
// In dev the worker is registered with ?dev=1 so it skips caching the Vite
// module graph (which would serve stale code) while still handling push.
if ("serviceWorker" in navigator && window.isSecureContext) {
  const swUrl = import.meta.env.DEV ? "/sw.js?dev=1" : "/sw.js";
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(swUrl);
  });
}
