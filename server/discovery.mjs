// Where Athena publishes its local ports and per-launch tokens. Desktop Athena
// writes ~/.context-workspace/*.json; a headless Athena server (`athena server
// run --data-dir DIR`) writes the same files into its data folder, so point
// ATHENA_SERVER_DATA_DIR (or ATHENA_DISCOVERY_DIR) there when hosting this app
// next to one. The push notifier keeps its keys and subscriptions here too, so
// changing the folder on a host with subscribers means re-enabling alerts.

import os from "node:os";
import path from "node:path";

export function discoveryDir(env = process.env, home = os.homedir()) {
  return env.ATHENA_DISCOVERY_DIR || env.ATHENA_SERVER_DATA_DIR || path.join(home, ".context-workspace");
}
