import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register the app-shell service worker in production only — in dev it would cache
// the Vite module graph and serve stale code across edits. The worker lets the PWA
// repaint instantly from cache when the OS evicts it in the background, instead of
// re-downloading the whole shell on every return.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
