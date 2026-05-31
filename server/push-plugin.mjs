// Vite plugin that hosts the push notifier inside the dev server, so a single
// `npm run dev` both serves the app and drives notifications — no separate
// sidecar process to launch or keep alive.

import { createPushNotifier } from "./push-notifier.mjs";

export function athenaPushPlugin() {
  return {
    name: "athena-push",
    apply: "serve",
    configureServer(server) {
      const notifier = createPushNotifier();
      // Mounting at the prefix makes req.url the remainder (e.g. "/vapid").
      server.middlewares.use("/athena-push", notifier.middleware);
      notifier.start();
      server.httpServer?.once("close", () => notifier.stop());
    },
  };
}
