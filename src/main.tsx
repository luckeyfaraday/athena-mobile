import React from "react";
import { createRoot } from "react-dom/client";
// Desktop Athena's typefaces; each theme picks its own, and a browser only
// downloads the files a painted theme uses.
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/manrope/wght.css";
import "@fontsource-variable/schibsted-grotesk/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "@fontsource-variable/bricolage-grotesque/wght.css";
import "@fontsource-variable/space-grotesk/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import { App } from "./App";
import { applyTheme, readLaptopTheme, readThemePreference, resolveTheme, systemPrefersLight } from "./themes";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles.css";

// Paint the saved theme before the first render so a cold start doesn't flash Classic.
applyTheme(resolveTheme(readThemePreference(), readLaptopTheme(), systemPrefersLight()));

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
