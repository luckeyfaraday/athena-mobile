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

// Service-worker registration lives in index.html so it can recover even when
// a stale or unavailable JavaScript bundle prevents React from starting.
