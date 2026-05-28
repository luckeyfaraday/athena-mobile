import type { ServiceState } from "./types";

export type AthenaMode = "demo" | "live";

export type AppConfig = {
  mode: AthenaMode;
  backendUrl: string;
  controlUrl: string;
  projectDir: string;
  token: string;
};

export function readConfig(): AppConfig {
  const mode = import.meta.env.VITE_ATHENA_MODE === "live" ? "live" : "demo";
  return {
    mode,
    backendUrl: trimSlash(import.meta.env.VITE_ATHENA_BACKEND_URL || (mode === "live" ? "/athena-backend" : "")),
    controlUrl: trimSlash(import.meta.env.VITE_ATHENA_CONTROL_URL || (mode === "live" ? "/athena-control" : "")),
    projectDir: import.meta.env.VITE_ATHENA_PROJECT_DIR || "",
    token: import.meta.env.VITE_ATHENA_TOKEN || "",
  };
}

export function initialServiceState(config: AppConfig): ServiceState {
  return {
    mode: config.mode,
    backend: {
      baseUrl: config.backendUrl || null,
      healthy: false,
      detail: config.backendUrl ? "Not checked" : "Backend URL is not configured.",
    },
    control: {
      baseUrl: config.controlUrl || null,
      healthy: false,
      detail: config.controlUrl ? "Not checked" : "Control URL is not configured.",
    },
  };
}

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
